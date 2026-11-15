import { InlineKeyboard, type Composer } from 'grammy';
import type { AppCtx } from '../../middleware/user.js';
import { env } from '../../env.js';
import {
  countVerificationsByStatus,
  isHumanVerifyReady,
  verifyBaseUrl,
} from '../../services/humanVerify.js';
import {
  getHumanVerifyEnabled,
  getHumanVerifyNumber,
  setHumanVerifyEnabled,
  setHumanVerifyNumber,
  type HumanVerifyNumberKey,
} from '../../services/settings.js';

const STEPS: Record<HumanVerifyNumberKey, number> = {
  ip_limit: 1,
  ref_reward: 0.01,
  user_bonus: 0.01,
  alert_threshold: 1,
};

function fmt(key: HumanVerifyNumberKey): string {
  const v = getHumanVerifyNumber(key);
  return key === 'ref_reward' || key === 'user_bonus' ? `$${v.toFixed(2)}` : String(v);
}

async function showHumanVerify(ctx: AppCtx): Promise<void> {
  const enabled = getHumanVerifyEnabled();
  const ready = await isHumanVerifyReady();
  const stats = ready ? await countVerificationsByStatus() : {};
  const row = (label: string, key: HumanVerifyNumberKey, kb: InlineKeyboard) =>
    kb
      .text('➖', `adm:hv:n:${key}:-`)
      .text(`${label}: ${fmt(key)}`, 'adm:hv')
      .text('➕', `adm:hv:n:${key}:+`)
      .row();
  const kb = new InlineKeyboard()
    .text(enabled ? '🛡 Human Verify: ON' : '🔓 Human Verify: OFF', 'adm:hv:toggle')
    .row();
  row('IP limit', 'ip_limit', kb);
  row('Refer reward', 'ref_reward', kb);
  row('New user bonus', 'user_bonus', kb);
  row('Alert / hour', 'alert_threshold', kb);
  kb.text('🔁 Refresh', 'adm:hv').row().text('⬅️ Back', 'adm:bot');
  const chat = (c: number | string | undefined) => (c === undefined ? 'off' : String(c));
  const lines = [
    '🛡 *Referral Human Verify*',
    '',
    `*Status:* ${enabled ? '*ON*' : '*OFF*'}`,
    `*Database:* ${ready ? 'ready' : 'run migration 0048 first'}`,
    `*Verify URL:* ${verifyBaseUrl() ? `\`${verifyBaseUrl()}/verify\`` : '_set VERIFY\\_BASE\\_URL_'}`,
    `*Log group:* \`${chat(env.REFERRAL_LOG_CHAT_ID)}\``,
    `*Alert group:* \`${chat(env.REFERRAL_ALERT_CHAT_ID)}\``,
  ];
  if (ready) {
    lines.push(
      '',
      `✅ Verified: ${stats.verified ?? 0}   ⏳ Pending: ${stats.pending ?? 0}`,
      `⏭ Skipped: ${stats.skipped ?? 0}   🚫 IP limit: ${stats.ip_limited ?? 0}`,
      `📱 Same device: ${stats.device_dup ?? 0}   ❌ Failed: ${stats.failed ?? 0}`,
    );
  }
  lines.push(
    '',
    '_When ON, new users who join with a referral link must verify (or Skip) before the refer counts. Skip, IP limit and same device = no reward. Old referrals keep their value._',
  );
  const text = lines.join('\n');
  const opts = { parse_mode: 'Markdown' as const, reply_markup: kb };
  try {
    await ctx.editMessageText(text, opts);
  } catch {
    // "message is not modified" when nothing changed.
  }
}

export function registerHumanVerifyAdmin(adminBot: Composer<AppCtx>): void {
  adminBot.callbackQuery('adm:hv', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHumanVerify(ctx);
  });

  adminBot.callbackQuery('adm:hv:toggle', async (ctx) => {
    const next = !getHumanVerifyEnabled();
    if (next && !(await isHumanVerifyReady())) {
      await ctx.answerCallbackQuery({
        text: 'Run supabase migration 0048_referral_human_verify.sql first.',
        show_alert: true,
      });
      return;
    }
    if (next && !verifyBaseUrl()) {
      await ctx.answerCallbackQuery({ text: 'Set VERIFY_BASE_URL in Railway first.', show_alert: true });
      return;
    }
    await setHumanVerifyEnabled(next, ctx.from.id);
    await ctx.answerCallbackQuery({ text: `Human verify ${next ? 'enabled' : 'disabled'}.` });
    await showHumanVerify(ctx);
  });

  adminBot.callbackQuery(/^adm:hv:n:(ip_limit|ref_reward|user_bonus|alert_threshold):([+-])$/, async (ctx) => {
    const key = ctx.match[1] as HumanVerifyNumberKey;
    const dir = ctx.match[2] === '+' ? 1 : -1;
    const v = await setHumanVerifyNumber(key, getHumanVerifyNumber(key) + dir * STEPS[key], ctx.from.id);
    await ctx.answerCallbackQuery({ text: `Saved: ${v}` });
    await showHumanVerify(ctx);
  });
}
