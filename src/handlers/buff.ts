/**
 * Shop → Buff Token product card: premium-emoji styled card with
 * admin-editable name/description/warranty, per-1B price, then a
 * code+amount input, price preview, confirm and wallet pay.
 */
import { InlineKeyboard, type Composer } from 'grammy';
import type { EmojiSpec } from '../../config/index.js';
import { logger } from '../logger.js';
import type { AppCtx } from '../middleware/user.js';
import {
  BUFF_MAX_LINES,
  BUFF_QTY_MAX,
  BUFF_QTY_MIN,
  BuffError,
  buffStatusLabel,
  isBuffMigrationError,
  listBuffOrders,
  placeBuffOrder,
  quoteBuff,
} from '../services/buff.js';
import { escapeAttr } from '../services/premium.js';
import {
  getBuffDescription,
  getBuffEmojiSpec,
  getBuffEnabled,
  getBuffName,
  getBuffUnitPrice,
  getBuffWarranty,
  getEmoji,
} from '../services/settings.js';

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

export function buffEmojiTag(spec: EmojiSpec): string {
  return typeof spec === 'object' && spec.custom_emoji_id
    ? `<tg-emoji emoji-id="${escapeAttr(spec.custom_emoji_id)}">${spec.unicode}</tg-emoji>`
    : typeof spec === 'object'
      ? spec.unicode
      : spec;
}

/** Render a config EMOJI key as a premium `<tg-emoji>` when it has an id. */
export function tgEmoji(key: string): string {
  return buffEmojiTag(getEmoji(key));
}

async function showOrEdit(ctx: AppCtx, html: string, kb: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(html, { ...HTML, reply_markup: kb });
      return;
    } catch (err) {
      if (/message is not modified/i.test(String((err as Error)?.message))) return;
    }
  }
  await ctx.reply(html, { ...HTML, reply_markup: kb });
}

export function buffErrorText(err: unknown): string {
  if (err instanceof BuffError) return `⚠️ ${escapeAttr(err.message)}`;
  if (isBuffMigrationError(err)) return '⚠️ Buff Token is not ready yet. Please try again later.';
  return '⚠️ Something went wrong. Please try again later.';
}

function unitPriceLine(): string {
  const unit = getBuffUnitPrice();
  return unit ? `<b>$${unit.toFixed(2)}</b> / 1B` : '<i>shown before paying</i>';
}

/** Product-card screen for the Buff Token feature. */
async function showBuffHome(ctx: AppCtx): Promise<void> {
  ctx.session.buffPending = undefined;
  ctx.session.userFlow = undefined;
  const name = getBuffName();
  const desc = getBuffDescription().trim();
  const lines = [
    `${buffEmojiTag(getBuffEmojiSpec())} <b>${escapeAttr(name)}</b>`,
    '',
    ...(desc ? [desc, ''] : []),
    `${tgEmoji('price')} <b>Price:</b> ${unitPriceLine()}  <i>(min 1B)</i>`,
    `${tgEmoji('warranty')} <b>Warranty:</b> ${escapeAttr(getBuffWarranty())}`,
    '',
    `${tgEmoji('freebie_desc')} <b>How it works:</b>`,
    `1️⃣ Tap <b>Buy ${escapeAttr(name)}</b>`,
    `2️⃣ Send your invite code + amount: <code>ABBADJ 20</code>`,
    `3️⃣ Check the price → Confirm → paid from your wallet`,
    `${tgEmoji('freebie_ok')} Tokens land in ~1-2 min · auto-refund on fail`,
    '',
    `${tgEmoji('profile_balance')} Wallet: <b>$${Number(ctx.user.balance ?? 0).toFixed(2)}</b>`,
  ];
  const kb = new InlineKeyboard()
    .text(`💎 Buy ${name}`, 'buff:buy')
    .row()
    .text('⬅️ Back', 'shop:home');
  await showOrEdit(ctx, lines.join('\n'), kb);
}

/** Ask for invite code + amount. */
async function showBuffInput(ctx: AppCtx): Promise<void> {
  ctx.session.userFlow = { type: 'buff_input', step: 'value', data: {} };
  const html = [
    `${tgEmoji('pencil')} <b>Send your invite code and amount</b> (in billion tokens):`,
    `<code>ABBADJ 20</code>`,
    '',
    `${tgEmoji('freebie_item')} ${BUFF_QTY_MIN}-${BUFF_QTY_MAX}B per code · up to ${BUFF_MAX_LINES} codes, one per line`,
    `${tgEmoji('freebie_kind')} You'll see the exact price before paying`,
  ].join('\n');
  const kb = new InlineKeyboard().text('❌ Cancel', 'buff:open');
  await showOrEdit(ctx, html, kb);
}

export function registerBuff(bot: Composer<AppCtx>): void {
  const guard = async (ctx: AppCtx): Promise<boolean> => {
    if (getBuffEnabled()) return true;
    await ctx.answerCallbackQuery({ text: 'Buff Token is not available right now.', show_alert: true });
    return false;
  };

  bot.callbackQuery('buff:open', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await showBuffHome(ctx);
  });

  bot.callbackQuery('buff:buy', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await showBuffInput(ctx);
  });

  bot.callbackQuery('buff:my', async (ctx) => {
    await ctx.answerCallbackQuery();
    let rows: Awaited<ReturnType<typeof listBuffOrders>> = [];
    try {
      rows = await listBuffOrders({ userId: ctx.user.telegram_id, limit: 10 });
    } catch (err) {
      if (!isBuffMigrationError(err)) logger.warn({ err }, 'buff my orders failed');
    }
    const lines = [`${tgEmoji('stats_orders')} <b>My Buff Orders</b>`, ''];
    if (rows.length === 0) lines.push('<i>No Buff orders yet.</i>');
    for (const o of rows) {
      const codes = o.orders_text.split('\n').map((l) => escapeAttr(l)).join(', ');
      lines.push(
        `<b>#B${o.id}</b> · ${o.total_qty}B · $${Number(o.price_usdt).toFixed(2)} · ${buffStatusLabel(o.status)}`,
        `<code>${codes}</code>`,
      );
    }
    const kb = new InlineKeyboard().text('⬅️ Back', 'buff:open');
    await showOrEdit(ctx, lines.join('\n'), kb);
  });

  bot.on('message:text', async (ctx, next) => {
    const flow = ctx.session.userFlow;
    if (!flow || flow.type !== 'buff_input') return next();
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.userFlow = undefined;
      return next();
    }
    if (!getBuffEnabled()) {
      ctx.session.userFlow = undefined;
      await ctx.reply('⚠️ Buff Token is not available right now.');
      return;
    }
    await ctx.replyWithChatAction('typing').catch(() => undefined);
    let quote;
    try {
      quote = await quoteBuff(text);
    } catch (err) {
      await ctx.reply(`${buffErrorText(err)}\n\nSend again, e.g. <code>ABBADJ 20</code>`, HTML);
      return;
    }
    if (!quote.fundable) {
      await ctx.reply('⚠️ Buff service is busy right now. Please try again in a few minutes.');
      return;
    }
    ctx.session.buffPending = { ordersText: quote.ordersText, price: quote.priceUsdt };
    const balance = Number(ctx.user.balance ?? 0);
    const per = quote.totalQty > 0 ? quote.priceUsdt / quote.totalQty : 0;
    const lines = [
      `${tgEmoji('stats_orders')} <b>Order preview</b>`,
      '',
      ...quote.lines.map((l) => `${tgEmoji('api_key')} <code>${escapeAttr(l.code)}</code> → <b>${l.qty}B</b>`),
      '',
      `${tgEmoji('total')} Total: <b>${quote.totalQty}B tokens</b> · $${per.toFixed(2)}/1B`,
      `${tgEmoji('price')} Price: <b>$${quote.priceUsdt.toFixed(2)}</b>`,
      `${tgEmoji('profile_balance')} Wallet: $${balance.toFixed(2)}`,
    ];
    const kb = new InlineKeyboard();
    if (balance < quote.priceUsdt) {
      lines.push('', '⚠️ Not enough balance. Top up first.');
      kb.text('💳 Top Up', 'topup:open').row();
    } else {
      kb.text(`✅ Confirm & Pay $${quote.priceUsdt.toFixed(2)}`, 'buff:ok').row();
    }
    kb.text('❌ Cancel', 'buff:open');
    await ctx.reply(lines.join('\n'), { ...HTML, reply_markup: kb });
  });

  bot.callbackQuery('buff:ok', async (ctx) => {
    const pending = ctx.session.buffPending;
    ctx.session.buffPending = undefined;
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'This order expired. Please send it again.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: '⏳ Placing order…' });
    ctx.session.userFlow = undefined;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    try {
      const res = await placeBuffOrder({
        api: ctx.api,
        userId: ctx.user.telegram_id,
        ordersText: pending.ordersText,
        channel: 'bot',
        chargeUser: true,
        maxPriceUsdt: pending.price,
      });
      const kb = new InlineKeyboard().text('📜 My Buff Orders', 'buff:my').text('🏠 Home', 'main:open');
      const head =
        res.status === 'placed'
          ? `${tgEmoji('freebie_ok')} <b>Buff Token order placed!</b>`
          : `${tgEmoji('refer_pending')} <b>Buff Token order received</b> — it is being checked.`;
      await ctx.reply(
        [
          head,
          '',
          `${tgEmoji('stats_orders')} Order: <b>#B${res.order.id}</b>`,
          `${tgEmoji('price')} Paid: <b>$${res.priceUsdt.toFixed(2)}</b>`,
          res.balanceAfter !== null ? `${tgEmoji('profile_balance')} Wallet: $${res.balanceAfter.toFixed(2)}` : '',
          '',
          'Tokens will be credited to your invite code within about 1-2 minutes. You will get a message when it is done. If it fails, you are refunded automatically.',
        ]
          .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
          .join('\n'),
        { ...HTML, reply_markup: kb },
      );
    } catch (err) {
      if (!(err instanceof BuffError)) logger.error({ err }, 'buff order failed');
      const refunded = err instanceof BuffError && Number(err.extra.refunded ?? 0) > 0;
      await ctx.reply(
        `${buffErrorText(err)}${refunded ? '\n\n↩️ Your payment was refunded to your wallet.' : ''}`,
        { ...HTML, reply_markup: new InlineKeyboard().text('🔁 Try Again', 'buff:open') },
      );
    }
  });
}
