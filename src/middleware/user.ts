/**
 * Loads the user from Supabase (creating them on first contact) and
 * attaches `ctx.user` + `ctx.lang` + `ctx.t()` for handlers.
 */
import type { MiddlewareFn } from 'grammy';
import { normalizeCurrency } from '../../config/currencies.js';
import type { Lang } from '../../config/index.js';
import { getOrCreateUser, setReferralFraudSuspected, getRecentReferralsByReferrer } from '../db/queries.js';
import { env } from '../env.js';
import { t as translate } from '../i18n/index.js';
import { renderMdHtml } from '../services/premium.js';
import type { DBUser } from '../types.js';
import type { SessionCtx } from './session.js';
import { maybeSendEmailNag } from '../services/emailNag.js';
import * as publicFeed from '../services/publicFeed.js';
import { InlineKeyboard } from 'grammy';

export type AppCtx = SessionCtx & {
  user: DBUser;
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

// Anti-fraud settings
const REFERRAL_BURST_THRESHOLD = 10; // Flag if 10+ referrals in short time
const REFERRAL_BURST_WINDOW_HOURS = 2; // Within 2 hours

/**
 * Check if user has joined all required channels
 */
async function checkRequiredChannels(ctx: AppCtx): Promise<{ passed: boolean; notJoined: string[] }> {
  const requiredChannels = env.REQUIRED_JOIN_CHANNELS || [];
  if (requiredChannels.length === 0) {
    return { passed: true, notJoined: [] };
  }

  const notJoined: string[] = [];
  
  for (const channel of requiredChannels) {
    try {
      const chatMember = await ctx.api.getChatMember(channel, ctx.from!.id);
      const status = chatMember.status;
      // Valid statuses: 'member', 'administrator', 'creator', 'restricted' (if not left)
      const isValid = ['member', 'administrator', 'creator', 'restricted'].includes(status);
      if (!isValid) {
        notJoined.push(channel);
      }
    } catch {
      // If we can't check (e.g., bot not in channel), skip
      notJoined.push(channel);
    }
  }

  return { passed: notJoined.length === 0, notJoined };
}

/**
 * Send force-join message with channel buttons
 */
async function sendForceJoinMessage(ctx: AppCtx, channels: string[]) {
  const kb = new InlineKeyboard();
  
  for (const channel of channels) {
    let displayName = channel;
    if (channel.startsWith('@')) {
      displayName = channel;
    } else if (channel.match(/^-?\d+$/)) {
      displayName = `Channel ${channel}`;
    }
    kb.url('📢 Join Channel', channel.startsWith('@') ? `https://t.me/${channel.slice(1)}` : `https://t.me/c/${Math.abs(parseInt(channel))}`);
    kb.row();
  }
  
  // Done button with unique callback data
  const doneCallbackData = `forcejoin_done:${ctx.from!.id}:${Date.now()}`;
  kb.text('✅ Done - I Have Joined', doneCallbackData);

  const message = `━━━━━━━━━━━━━━━━━━━━
🔒 *Access Restricted*

⚠️ Please join our channel(s) first to use this bot!

👇 Tap below to join:
━━━━━━━━━━━━━━━━━━━━`;

  await ctx.reply(renderMdHtml(message), {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
}

/**
 * Handle force-join callback (when user clicks "Done")
 */
export async function handleForceJoinCallback(ctx: AppCtx): Promise<boolean> {
  const requiredChannels = env.REQUIRED_JOIN_CHANNELS || [];
  if (requiredChannels.length === 0) return false;

  const match = ctx.callbackQuery?.data?.match(/^forcejoin_done:(\d+):(\d+)$/);
  if (!match) return false;
  
  const callbackUserId = parseInt(match[1]!);
  // Verify this callback is from the same user
  if (callbackUserId !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: '❌ This is not for you!' });
    return true;
  }

  // Re-check membership
  const { passed, notJoined } = await checkRequiredChannels(ctx);
  
  if (passed) {
    await ctx.answerCallbackQuery({ text: '✅ Access granted! You can now use the bot.' });
    await ctx.editMessageText('━━━━━━━━━━━━━━━━━━━━\n🎉 *Access Granted!*\n\nWelcome aboard! You now have full access to the bot.\n━━━━━━━━━━━━━━━━━━━━', {
      parse_mode: 'Markdown',
    });
    return true;
  } else {
    await ctx.answerCallbackQuery({ text: '❌ You still haven\'t joined all channels!', show_alert: true });
    return true;
  }
}

/**
 * Look at the most recent /start payload (if any) for a referral code
 * like `?start=R12AB`. Stored on the user via getOrCreateUser.
 */
function extractReferral(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.match(/^\/start(?:@\S+)?\s+R([A-Z0-9]+)/i);
  if (!m) return null;
  const id = parseInt(m[1]!, 36);
  return Number.isFinite(id) ? id : null;
}

export const userMiddleware: MiddlewareFn<AppCtx> = async (ctx, next) => {
  if (!ctx.from) return next();
  
  // Check force-join channels first
  const requiredChannels = env.REQUIRED_JOIN_CHANNELS || [];
  if (requiredChannels.length > 0) {
    const { passed, notJoined } = await checkRequiredChannels(ctx);
    if (!passed) {
      await sendForceJoinMessage(ctx, notJoined);
      return; // Block access until they join
    }
  }
  
  const referred_by = extractReferral(ctx.message?.text ?? undefined);

  const user = await getOrCreateUser({
    telegram_id: ctx.from.id,
    username: ctx.from.username ?? null,
    first_name: ctx.from.first_name ?? null,
    last_name: ctx.from.last_name ?? null,
    language: env.DEFAULT_LANG,
    referred_by,
  });

  ctx.user = user;
  ctx.user.currency = normalizeCurrency((user as DBUser & { currency?: string | null }).currency);
  ctx.lang = user.language;
  ctx.t = (key, vars) => translate(ctx.lang, key, vars);

  // Fire-and-forget the 12h email nag.
  void maybeSendEmailNag(ctx);

  // If this is a newly created user with a referrer, notify the referrer
  // directly and mirror it to the admin channel when configured.
  if (
    (user as DBUser & { __just_created?: boolean }).__just_created &&
    user.referred_by
  ) {
    // Fire-and-forget referral notification (non-blocking)
    void sendReferralNotificationSafe(ctx, user.referred_by, ctx.from.id, ctx.from.username ?? null, ctx.from.first_name);
  }

  return next();
};

function cleanDisplayName(value: string): string {
  return value.replace(/[*_`~]/g, '').trim() || 'New user';
}

/**
 * Safe referral notification - doesn't block the bot
 */
async function sendReferralNotificationSafe(
  ctx: AppCtx,
  referrerId: number,
  refereeId: number,
  refereeUsername: string | null,
  refereeFirstName: string | null,
) {
  try {
    await sendReferralNotification(ctx, referrerId, refereeId, refereeUsername, refereeFirstName);
  } catch (err) {
    console.error('Referral notification failed:', err);
  }
}

/**
 * Check for referral fraud patterns and alert admin
 */
async function checkReferralFraud(
  ctx: AppCtx,
  referrerId: number,
  refereeId: number,
  refereeUsername: string | null,
  refereeFirstName: string | null,
) {
  try {
    // Get recent referrals for this referrer
    const recentRefs = await getRecentReferralsByReferrer(referrerId, REFERRAL_BURST_WINDOW_HOURS);
    
    if (recentRefs.length >= REFERRAL_BURST_THRESHOLD) {
      // Suspicious activity detected!
      const referrer = await ctx.api.getChat(referrerId).catch(() => null);
      const referrerName = referrer?.username ? `@${referrer.username}` : referrer?.first_name ?? `ID: ${referrerId}`;
      
      const refereeDisplay = cleanDisplayName(
        refereeUsername ? `@${refereeUsername}` : refereeFirstName ?? `ID: ${refereeId}`,
      );
      
      // Auto-flag the referrer for fraud
      await setReferralFraudSuspected(referrerId, true);
      
      // Alert admin channel
      if (env.LOG_CHAT_ID && env.LOG_CHAT_ID !== '0') {
        const alertMsg = `🚨 *REFERRAL FRAUD ALERT*\n\n` +
          `User ${referrerName} got *${recentRefs.length}* referrals in *${REFERRAL_BURST_WINDOW_HOURS} hour(s)*!\n\n` +
          `Latest refer: ${refereeDisplay}\n\n` +
          `User has been auto-flagged. Use /banuser ${referrerId} to ban.`;
        
        await ctx.api.sendMessage(env.LOG_CHAT_ID, renderMdHtml(alertMsg), { parse_mode: 'HTML' }).catch(() => {});
      }
      
      console.warn(`Referral fraud detected: User ${referrerId} got ${recentRefs.length} referrals in ${REFERRAL_BURST_WINDOW_HOURS}h`);
    }
  } catch (err) {
    console.error('Referral fraud check failed:', err);
  }
}

/**
 * Send referral notifications. The user DM must not depend on optional
 * admin-channel settings or newer referral-balance tables.
 */
async function sendReferralNotification(
  ctx: AppCtx,
  referrerId: number,
  refereeId: number,
  refereeUsername: string | null,
  refereeFirstName: string | null,
) {
  const { getUserByTelegramId, getReferralBalance, getReferralEarnings } = await import('../db/queries.js');

  const referrer = await getUserByTelegramId(referrerId);
  if (!referrer) return;

  const referrerUsername = cleanDisplayName(
    referrer.username ? `@${referrer.username}` : referrer.first_name ?? `User ${referrer.telegram_id}`,
  );
  const refereeDisplay = cleanDisplayName(
    refereeUsername ? `@${refereeUsername}` : refereeFirstName ?? `User ${refereeId}`,
  );

  let refBalance = { total: 0, spent: 0, available: 0 };
  let totalEarned = 0;
  try {
    refBalance = await getReferralBalance(referrerId);
  } catch {
    refBalance = { total: 0, spent: 0, available: 0 };
  }
  try {
    totalEarned = (await getReferralEarnings(referrerId)).total;
  } catch {
    totalEarned = 0;
  }
  // Existing notification templates call this "totalRefs", but the
  // number shown to users must be the spendable Referral Pay balance:
  // lifetime referrals minus purchase/conversion spends.
  const totalRefs = refBalance.available;

  const userMsg = `🎁 *You Got a Refer +1!*

👤 *New Active Refer:* ${refereeDisplay}
✅ *Active Refers:* ${totalRefs} refs
💎 *Referral Pay Balance:* ${totalRefs} refs

Keep sharing your link and stack rewards.`;

  await ctx.api
    .sendMessage(referrerId, renderMdHtml(userMsg), { parse_mode: 'HTML' })
    .catch(() => {});

  void publicFeed.notifyActiveReferral(ctx.api, {
    referrerName: referrerUsername,
    totalReferrals: refBalance.total,
    activeReferrals: totalRefs,
    totalEarned,
  });
  if (totalRefs > 0 && totalRefs % 10 === 0) {
    void publicFeed.notifyReferralAchievement(ctx.api, {
      userId: referrerId,
      amount: 0.1,
    });
  }
  
  // Check for fraud after successful referral
  await checkReferralFraud(ctx, referrerId, refereeId, refereeUsername, refereeFirstName);
}
