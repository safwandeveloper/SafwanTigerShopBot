import type { Composer, NextFunction } from 'grammy';
import type { AppCtx } from '../middleware/user.js';
import { logger } from '../logger.js';
import {
  isHumanVerifyPending,
  refreshPending,
  sendVerifyPrompt,
  skipHumanVerification,
} from '../services/humanVerify.js';
import { showMainMenu } from './start.js';

// The in-memory pending set is lost on restart, so referred users get a
// one-time DB check per process lifetime before being let through.
const checkedUsers = new Set<number>();

/**
 * Keeps a referred new user on the verify prompt until they verify or
 * tap Skip. Fails open: if the DB check errors the user is let through.
 */
export async function humanVerifyGate(ctx: AppCtx, next: NextFunction): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid || ctx.chat?.type !== 'private') return next();
  if (ctx.callbackQuery?.data === 'hv:skip') return next();
  let pending = isHumanVerifyPending(uid);
  try {
    if (!pending && ctx.user?.referred_by && !checkedUsers.has(uid)) {
      checkedUsers.add(uid);
      pending = await refreshPending(uid);
    } else if (pending) {
      pending = await refreshPending(uid);
    }
  } catch (err) {
    logger.warn({ err, uid }, 'human verify gate check failed');
    pending = false;
  }
  if (!pending) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: "Please verify you're human first, or tap Skip.",
      show_alert: true,
    });
    return;
  }
  await sendVerifyPrompt(ctx.api, uid, uid);
}

export function registerHumanVerify(bot: Composer<AppCtx>): void {
  bot.callbackQuery('hv:skip', async (ctx) => {
    await skipHumanVerification(ctx.api, {
      telegram_id: ctx.from.id,
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? null,
    });
    await ctx.answerCallbackQuery({ text: 'Skipped. No reward was added.' });
    await showMainMenu(ctx, { fresh: true });
  });
}
