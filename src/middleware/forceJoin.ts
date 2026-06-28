import { InlineKeyboard, type MiddlewareFn } from 'grammy';
import type { AppCtx } from './user.js';
import { logger } from '../logger.js';
import { renderMdHtml } from '../services/premium.js';
import { getChannelUrl, getForceJoinEnabled } from '../services/settings.js';

const DEFAULT_FORCE_JOIN_CHANNEL = '@safwantigerstore';

function forceJoinChatId(channelUrl: string): string | number | null {
  const raw = channelUrl.trim();
  if (/^-100\d+$/.test(raw)) return Number(raw);
  if (/^@[A-Za-z0-9_]{5,}$/i.test(raw)) return raw;
  const m = raw.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]{5,})(?:\/.*)?$/i);
  return m ? `@${m[1]}` : null;
}

function forceJoinUrl(channelUrl: string): string {
  const raw = channelUrl.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('@')) return `https://t.me/${raw.slice(1)}`;
  return raw;
}

async function hasJoinedForceChannel(ctx: AppCtx, channelUrl: string): Promise<boolean> {
  const chatId = forceJoinChatId(channelUrl);
  if (!chatId) {
    logger.warn({ channelUrl }, 'force-join: invalid channel URL; blocking access');
    return false;
  }
  try {
    const member = await ctx.api.getChatMember(chatId, ctx.from!.id);
    return !['left', 'kicked'].includes(member.status);
  } catch (err) {
    logger.warn({ err, channelUrl }, 'force-join: membership check failed; blocking access');
    return false;
  }
}

async function showForceJoinPrompt(ctx: AppCtx, channelUrl: string): Promise<void> {
  const kb = new InlineKeyboard()
    .url('📣 Join Channel', forceJoinUrl(channelUrl))
    .row()
    .text('✅ Done', 'forcejoin:done');
  const text = [
    '🔔 *Please join our Channel to continue using this bot.*',
    '',
    'After joining, tap *"Done ✅"* below.',
  ].join('\n');
  await ctx.reply(renderMdHtml(text), { parse_mode: 'HTML', reply_markup: kb });
}

export async function isForceJoinSatisfied(ctx: AppCtx): Promise<boolean> {
  if (!getForceJoinEnabled()) return true;
  const channelUrl = getChannelUrl() ?? DEFAULT_FORCE_JOIN_CHANNEL;
  return hasJoinedForceChannel(ctx, channelUrl);
}

export async function sendForceJoinPrompt(ctx: AppCtx): Promise<void> {
  const channelUrl = getChannelUrl() ?? DEFAULT_FORCE_JOIN_CHANNEL;
  await showForceJoinPrompt(ctx, channelUrl);
}

export const forceJoinMiddleware: MiddlewareFn<AppCtx> = async (ctx, next) => {
  if (!ctx.from) return next();
  if (!getForceJoinEnabled()) return next();
  if (ctx.callbackQuery?.data === 'forcejoin:done') return next();
  if (ctx.from.id === Number(process.env.ADMIN_USER_ID || 0)) return next();

  if (await isForceJoinSatisfied(ctx)) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: 'Please join the channel first, then tap Done.',
      show_alert: true,
    });
  }
  await sendForceJoinPrompt(ctx);
};
