/**
 * Referral human verification: signed verify links, server-side
 * challenges, hashed IP / device ids, and the referral log / alert
 * groups. Additive: when disabled (default) or when migration 0048 is
 * missing, the legacy referral flow runs unchanged.
 */
import crypto from 'node:crypto';
import { InlineKeyboard, type Api } from 'grammy';
import { supabase } from '../db/supabase.js';
import { getReferralBalance, getUserByTelegramId, resolveValidReferrer } from '../db/queries.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import * as publicFeed from './publicFeed.js';
import { getHumanVerifyEnabled, getHumanVerifyNumber } from './settings.js';

export const LINK_TTL_SECONDS = 15 * 60;
export const MAX_ATTEMPTS = 3;

const BELL_EMOJI_ID = '5798670723975221399';
const DONE_EMOJI_ID = '6170055790146098906';
const SKIP_EMOJI_ID = '5843822645711212265';

export type VerifyStatus = 'pending' | 'verified' | 'skipped' | 'ip_limited' | 'device_dup' | 'failed';

export type VerificationRow = {
  user_id: number;
  referrer_id: number | null;
  status: VerifyStatus;
  attempts: number;
};

type LogUser = { telegram_id: number; username?: string | null; first_name?: string | null };

// ---------- secrets / tokens ----------

let cachedSecret: Buffer | null = null;
function secret(): Buffer {
  if (cachedSecret) return cachedSecret;
  cachedSecret = env.VERIFY_SECRET
    ? Buffer.from(env.VERIFY_SECRET, 'utf8')
    : crypto.createHmac('sha256', env.BOT_TOKEN).update('safwantiger-human-verify').digest();
  return cachedSecret;
}

function mac(purpose: string, data: string, len = 32): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${purpose}:${data}`)
    .digest('base64url')
    .slice(0, len);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function signLinkToken(userId: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const payload = `${userId}.${exp}`;
  return `${payload}.${mac('link', payload)}`;
}

export type LinkToken = { userId: number; exp: number; expired: boolean };

export function parseLinkToken(token: string | null | undefined): LinkToken | null {
  const m = String(token ?? '').match(/^(\d{1,20})\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/);
  if (!m) return null;
  const payload = `${m[1]}.${m[2]}`;
  if (!safeEqual(m[3]!, mac('link', payload))) return null;
  const exp = Number(m[2]);
  return { userId: Number(m[1]), exp, expired: exp * 1000 < Date.now() };
}

export function verifyBaseUrl(): string | null {
  const base = (env.VERIFY_BASE_URL || env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return base || null;
}

export function verifyUrl(userId: number): string | null {
  const base = verifyBaseUrl();
  return base ? `${base}/verify?t=${encodeURIComponent(signLinkToken(userId))}` : null;
}

// ---------- IP / device ----------

export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  if (ip.includes(':')) {
    const [head = ''] = ip.split('::');
    const groups = head.split(':').filter(Boolean);
    while (groups.length < 4) groups.push('0');
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  return ip;
}

export function hashIp(ip: string): string {
  return mac('ip', normalizeIp(ip), 43);
}

export function hashDevice(dev: unknown): string | null {
  if (typeof dev !== 'string' || !/^[a-f0-9]{16,64}$/.test(dev)) return null;
  return mac('dev', dev, 43);
}

export function maskIp(ip: string): string {
  const v = ip.trim();
  if (v.includes('.') && !v.includes(':')) {
    const p = v.split('.');
    if (p.length === 4) return `${p[0]}.${p[1]}.•••.${p[3]}`;
  }
  if (v.includes(':')) {
    const p = v.split(':').filter(Boolean);
    return `${p.slice(0, 2).join(':')}:•••`;
  }
  return '•••';
}

// ---------- challenges ----------

const rnd = (a: number, b: number): number => a + crypto.randomInt(b - a + 1);
const pick = <T>(arr: readonly T[]): T => arr[crypto.randomInt(arr.length)]!;
function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const EMOJIS: ReadonlyArray<readonly [string, string]> = [
  ['🍎', 'apple'], ['🦊', 'fox'], ['⭐', 'star'], ['🍩', 'donut'], ['🐸', 'frog'], ['🚀', 'rocket'],
  ['🍓', 'strawberry'], ['🐝', 'bee'], ['⚽', 'football'], ['🌵', 'cactus'], ['🐼', 'panda'], ['🍉', 'watermelon'],
];
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['🍎', '🍏'], ['🐶', '🐱'], ['🌙', '⭐'], ['🍋', '🍊'], ['🚗', '🚕'], ['❤️', '💙'], ['🐻', '🐼'], ['⚽', '🏀'],
];

export type Challenge = { tag: string; disp: string; num?: 1; emo?: 1; q: string; opts: string[] };

function nums(ans: number, lo = 1): string[] {
  const s = new Set([ans]);
  while (s.size < 4) {
    const d = ans + rnd(-4, 4);
    if (d >= lo && d !== ans) s.add(d);
  }
  return shuffle([...s]).map(String);
}

const TYPES: Record<string, () => { c: Challenge; ans: string }> = {
  count() {
    const e = pick(EMOJIS)[0];
    const a = rnd(1, 4);
    const b = rnd(1, 4);
    return {
      c: { tag: 'Count', disp: `${e.repeat(a)}<span class="op">+</span>${e.repeat(b)}`, q: 'How many in total?', opts: nums(a + b) },
      ans: String(a + b),
    };
  },
  math() {
    const op = pick(['+', '−', '×'] as const);
    let a = rnd(2, 9);
    let b = rnd(2, 9);
    if (op === '−' && b > a) [a, b] = [b, a];
    const r = op === '+' ? a + b : op === '−' ? a - b : a * b;
    return { c: { tag: 'Math', disp: `${a} ${op} ${b} = ?`, num: 1, q: 'Pick the correct answer', opts: nums(r, 0) }, ans: String(r) };
  },
  find() {
    const set = shuffle(EMOJIS).slice(0, 4);
    const t = pick(set);
    return { c: { tag: 'Find', disp: t[0], q: `Tap the ${t[1]}`, opts: set.map((s) => s[0]), emo: 1 }, ans: t[0] };
  },
  odd() {
    const [m, o] = shuffle(pick(PAIRS)) as [string, string];
    const row = [m, m, m, m];
    row[rnd(0, 3)] = o;
    const extra = shuffle(EMOJIS.filter((e) => e[0] !== m && e[0] !== o)).slice(0, 2).map((e) => e[0]);
    return { c: { tag: 'Odd one out', disp: row.join(' '), q: 'Which emoji is different?', opts: shuffle([m, o, ...extra]), emo: 1 }, ans: o };
  },
  seq() {
    const s = rnd(1, 6);
    const d = rnd(2, 5);
    const miss = rnd(1, 3);
    const arr: Array<number | string> = [0, 1, 2, 3, 4].map((i) => s + i * d);
    const r = arr[miss] as number;
    arr[miss] = '?';
    return { c: { tag: 'Sequence', disp: arr.join(', '), num: 1, q: 'Which number is missing?', opts: nums(r) }, ans: String(r) };
  },
};

/** Generates a challenge plus a signed token that binds the answer. */
export function createChallenge(userId: number): { challenge: Challenge; token: string } {
  const { c, ans } = pick(Object.values(TYPES))();
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const nonce = crypto.randomBytes(9).toString('base64url');
  const payload = `${userId}.${exp}.${nonce}`;
  return { challenge: c, token: `${payload}.${mac('ans', `${payload}.${ans}`)}` };
}

export function checkChallengeAnswer(userId: number, token: unknown, answer: unknown): boolean {
  const m = String(token ?? '').match(/^(\d{1,20})\.(\d{1,12})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{32})$/);
  if (!m || Number(m[1]) !== userId) return false;
  if (Number(m[2]) * 1000 < Date.now()) return false;
  if (typeof answer !== 'string' || answer.length > 32) return false;
  return safeEqual(m[4]!, mac('ans', `${m[1]}.${m[2]}.${m[3]}.${answer}`));
}

// ---------- DB helpers ----------

let readyCache: { ok: boolean; at: number } | null = null;

/** True once migration 0048 is applied. Cached for one minute. */
export async function isHumanVerifyReady(): Promise<boolean> {
  if (readyCache && Date.now() - readyCache.at < 60_000) return readyCache.ok;
  const [tbl, col] = await Promise.all([
    supabase.from('human_verifications').select('user_id').limit(1),
    supabase.from('referrals').select('reward_usd').limit(1),
  ]);
  const ok = !tbl.error && !col.error;
  if (!ok) logger.warn({ err: tbl.error ?? col.error }, 'human verify: migration 0048 not applied');
  readyCache = { ok, at: Date.now() };
  return ok;
}

export async function getVerification(userId: number): Promise<VerificationRow | null> {
  const { data, error } = await supabase
    .from('human_verifications')
    .select('user_id,referrer_id,status,attempts')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    logger.warn({ err: error, userId }, 'getVerification failed');
    return null;
  }
  return (data as VerificationRow | null) ?? null;
}

const pendingUsers = new Set<number>();

export function isHumanVerifyPending(userId: number): boolean {
  return pendingUsers.has(userId);
}

/** Re-reads the row; clears the in-memory gate once it is no longer pending. */
export async function refreshPending(userId: number): Promise<boolean> {
  const row = await getVerification(userId);
  if (row?.status === 'pending') return true;
  pendingUsers.delete(userId);
  return false;
}

export async function countVerificationsByStatus(): Promise<Record<string, number>> {
  const statuses: VerifyStatus[] = ['pending', 'verified', 'skipped', 'ip_limited', 'device_dup', 'failed'];
  const out: Record<string, number> = {};
  await Promise.all(
    statuses.map(async (s) => {
      const { count } = await supabase
        .from('human_verifications')
        .select('user_id', { count: 'exact', head: true })
        .eq('status', s);
      out[s] = count ?? 0;
    }),
  );
  return out;
}

// ---------- Telegram helpers ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function who(u: LogUser | null, id: number | null): string {
  if (!u && !id) return '—';
  const tid = u?.telegram_id ?? id!;
  const name = esc(u?.first_name?.trim() || 'User');
  const handle = u?.username ? ` (@${esc(u.username)})` : '';
  return `<a href="tg://user?id=${tid}">${name}</a>${handle} <code>${tid}</code>`;
}

function nowText(): string {
  return `${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi', hour12: false })} PKT`;
}

const LOG_LABEL: Record<VerifyStatus, string> = {
  pending: '⏳ <b>Pending</b> — waiting for human verification',
  verified: '✅ <b>Verified</b> — refer credited',
  skipped: '⏭ <b>Skipped</b> — no reward',
  ip_limited: '🚫 <b>IP limit reached</b> — no reward',
  device_dup: '📱 <b>Same device</b> — no reward',
  failed: '❌ <b>Failed</b> — too many wrong answers, no reward',
};

async function sendTo(api: Api, chat: number | string | undefined, html: string): Promise<void> {
  if (chat === undefined) return;
  try {
    await api.sendMessage(chat, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (err) {
    logger.warn({ err, chat }, 'human verify: group message failed');
  }
}

async function logEvent(
  api: Api,
  status: VerifyStatus,
  user: LogUser,
  referrerId: number | null,
  extra?: string,
): Promise<void> {
  const referrer = referrerId ? await getUserByTelegramId(referrerId).catch(() => null) : null;
  const lines = [
    '<b>🛡 Referral Verification</b>',
    '',
    `<b>Status:</b> ${LOG_LABEL[status]}`,
    `<b>Referrer:</b> ${who(referrer, referrerId)}`,
    `<b>New user:</b> ${who(user, user.telegram_id)}`,
    `<b>Time:</b> ${nowText()}`,
  ];
  if (extra) lines.push(extra);
  await sendTo(api, env.REFERRAL_LOG_CHAT_ID, lines.join('\n'));
}

const lastAlertAt = new Map<number, number>();

async function maybeAlert(api: Api, referrerId: number): Promise<void> {
  const threshold = getHumanVerifyNumber('alert_threshold');
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('human_verifications')
    .select('user_id', { count: 'exact', head: true })
    .eq('referrer_id', referrerId)
    .eq('status', 'verified')
    .gte('verified_at', since);
  if (error || (count ?? 0) <= threshold) return;
  const last = lastAlertAt.get(referrerId) ?? 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  lastAlertAt.set(referrerId, Date.now());
  const referrer = await getUserByTelegramId(referrerId).catch(() => null);
  await sendTo(
    api,
    env.REFERRAL_ALERT_CHAT_ID,
    [
      '<b>🚨 Referral abuse alert</b>',
      '',
      `<b>Referrer:</b> ${who(referrer, referrerId)}`,
      `<b>Verified refers in the last hour:</b> ${count} (limit ${threshold})`,
      `<b>Time:</b> ${nowText()}`,
    ].join('\n'),
  );
}

export async function sendVerifyPrompt(api: Api, chatId: number, userId: number): Promise<boolean> {
  const url = verifyUrl(userId);
  if (!url) return false;
  const bonus = getHumanVerifyNumber('user_bonus');
  const kb = new InlineKeyboard().url('Open Verify Link', url).row().text('Skip', 'hv:skip');
  const lines = [
    `<tg-emoji emoji-id="${BELL_EMOJI_ID}">🔔</tg-emoji> <b>Verify you're human</b>`,
    '',
    `<tg-emoji emoji-id="${DONE_EMOJI_ID}">✅</tg-emoji> One quick check to activate your account.`,
  ];
  if (bonus > 0) lines.push(`<tg-emoji emoji-id="${DONE_EMOJI_ID}">✅</tg-emoji> Get <b>$${bonus.toFixed(2)}</b> in your wallet after verifying.`);
  lines.push(
    '',
    `<tg-emoji emoji-id="${SKIP_EMOJI_ID}">⏭</tg-emoji> <b>Warning:</b> if you tap <b>Skip</b>, your referral will <b>not</b> count and you will <b>not</b> receive your bonus. The bot stays locked until you verify or skip.`,
    '',
    `<i>The link is valid for ${Math.round(LINK_TTL_SECONDS / 60)} minutes.</i>`,
  );
  try {
    await api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    logger.warn({ err, userId }, 'human verify: prompt failed');
    return false;
  }
}

/**
 * Takes over referral activation for a newly referred user. Returns
 * true when verification handles the referral (the legacy immediate
 * credit must then be skipped).
 */
export async function startHumanVerification(
  api: Api,
  user: LogUser & { referred_by?: number | null },
  chatId: number,
): Promise<boolean> {
  if (!getHumanVerifyEnabled() || !user.referred_by || !verifyBaseUrl()) return false;
  if (!(await isHumanVerifyReady())) return false;
  const referrerId = await resolveValidReferrer(user.referred_by, user.telegram_id);
  if (!referrerId) return false;
  const { data, error } = await supabase
    .from('human_verifications')
    .upsert(
      { user_id: user.telegram_id, referrer_id: referrerId, status: 'pending' },
      { onConflict: 'user_id', ignoreDuplicates: true },
    )
    .select('user_id');
  if (error) {
    logger.warn({ err: error, userId: user.telegram_id }, 'human verify: create row failed');
    return false;
  }
  const inserted = (data ?? []).length > 0;
  if (!inserted) {
    if (await refreshPending(user.telegram_id)) pendingUsers.add(user.telegram_id);
    return true;
  }
  pendingUsers.add(user.telegram_id);
  await sendVerifyPrompt(api, chatId, user.telegram_id);
  void logEvent(api, 'pending', user, referrerId);
  return true;
}

export async function skipHumanVerification(api: Api, user: LogUser): Promise<boolean> {
  const { data, error } = await supabase
    .from('human_verifications')
    .update({ status: 'skipped', updated_at: new Date().toISOString() })
    .eq('user_id', user.telegram_id)
    .eq('status', 'pending')
    .select('referrer_id');
  pendingUsers.delete(user.telegram_id);
  if (error || !data?.length) return false;
  void logEvent(api, 'skipped', user, (data[0] as { referrer_id: number | null }).referrer_id);
  return true;
}

export async function recordWrongAnswer(
  api: Api,
  userId: number,
): Promise<{ status: VerifyStatus; attempts: number }> {
  const { data, error } = await supabase.rpc('record_human_verify_attempt', {
    p_user_id: userId,
    p_max: MAX_ATTEMPTS,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { status: VerifyStatus; attempts: number };
  if (row.status === 'failed') {
    pendingUsers.delete(userId);
    const [user, v] = await Promise.all([getUserByTelegramId(userId), getVerification(userId)]);
    if (user) void logEvent(api, 'failed', user, v?.referrer_id ?? null);
    void notifyUser(api, userId, '❌ <b>Verification failed.</b> No reward was added, but you can keep using the bot. Send /start to open the menu.');
  }
  return row;
}

async function notifyUser(api: Api, userId: number, html: string): Promise<void> {
  try {
    await api.sendMessage(userId, html, { parse_mode: 'HTML' });
  } catch (err) {
    logger.debug({ err, userId }, 'human verify: user notify failed');
  }
}

export async function completeHumanVerification(
  api: Api,
  userId: number,
  ipHash: string | null,
  deviceHash: string | null,
): Promise<VerifyStatus> {
  const refReward = getHumanVerifyNumber('ref_reward');
  const bonus = getHumanVerifyNumber('user_bonus');
  const { data, error } = await supabase.rpc('complete_human_verification', {
    p_user_id: userId,
    p_ip_hash: ipHash,
    p_device_hash: deviceHash,
    p_ip_limit: getHumanVerifyNumber('ip_limit'),
    p_ref_reward: refReward,
    p_user_bonus: bonus,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as {
    status: VerifyStatus;
    referrer_id: number | null;
    referral_created: boolean;
    new_balance: number | null;
  };
  pendingUsers.delete(userId);
  void afterComplete(api, userId, row, refReward, bonus).catch((err) =>
    logger.warn({ err, userId }, 'human verify: post-complete side effects failed'),
  );
  return row.status;
}

async function afterComplete(
  api: Api,
  userId: number,
  row: { status: VerifyStatus; referrer_id: number | null; referral_created: boolean },
  refReward: number,
  bonus: number,
): Promise<void> {
  if (!['verified', 'ip_limited', 'device_dup'].includes(row.status)) return;
  const user = await getUserByTelegramId(userId);
  if (!user) return;
  if (row.status !== 'verified') {
    void logEvent(api, row.status, user, row.referrer_id);
    await notifyUser(
      api,
      userId,
      `<tg-emoji emoji-id="${DONE_EMOJI_ID}">✅</tg-emoji> <b>Verified.</b> ${
        row.status === 'device_dup'
          ? 'This device was already used to verify another account, so no reward was added.'
          : 'The maximum number of accounts has already been verified from this network, so no reward was added.'
      } Send /start to open the menu.`,
    );
    return;
  }
  void logEvent(
    api,
    'verified',
    user,
    row.referrer_id,
    `<b>Rewards:</b> referrer +$${refReward.toFixed(2)}${row.referral_created ? '' : ' (already counted)'} · new user +$${bonus.toFixed(2)}`,
  );
  await notifyUser(
    api,
    userId,
    `<tg-emoji emoji-id="${DONE_EMOJI_ID}">✅</tg-emoji> <b>Verification complete!</b>${
      bonus > 0 ? ` <b>$${bonus.toFixed(2)}</b> was added to your wallet.` : ''
    } Send /start to open the menu.`,
  );
  if (!row.referral_created || !row.referrer_id) return;
  const name = esc(user.first_name?.trim() || (user.username ? `@${user.username}` : 'A new user'));
  await notifyUser(
    api,
    row.referrer_id,
    `<tg-emoji emoji-id="${BELL_EMOJI_ID}">🔔</tg-emoji> <b>New verified refer!</b>\n\n${name} verified as human. You got <b>+1 refer</b> (+$${refReward.toFixed(2)}).`,
  );
  void maybeAlert(api, row.referrer_id);
  try {
    const [referrer, balance] = await Promise.all([
      getUserByTelegramId(row.referrer_id),
      getReferralBalance(row.referrer_id),
    ]);
    await publicFeed.notifyActiveReferral(api, {
      referrerName: referrer?.first_name ?? referrer?.username ?? 'User',
      totalReferrals: balance.total,
      activeReferrals: balance.total,
      totalEarned: Number(referrer?.referral_earned_total ?? 0),
    });
  } catch (err) {
    logger.debug({ err }, 'human verify: public feed failed');
  }
}
