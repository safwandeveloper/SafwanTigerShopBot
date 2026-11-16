/**
 * Shop → 🚀 Buff Token Muse AI: user sends invite codes + amounts, sees
 * the price, confirms, pays from wallet. See services/buff.ts.
 */
import { InlineKeyboard, type Composer } from 'grammy';
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
import { getBuffEnabled } from '../services/settings.js';

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

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

async function showBuffHome(ctx: AppCtx): Promise<void> {
  ctx.session.userFlow = { type: 'buff_input', step: 'value', data: {} };
  ctx.session.buffPending = undefined;
  const html = [
    '🚀 <b>Buff Token Muse AI</b>',
    '',
    'Top up Muse AI tokens straight to your invite code.',
    '',
    '✍️ <b>Send your invite code and amount</b> (in billion tokens):',
    `<code>ABBADJ 20</code>`,
    '',
    `• ${BUFF_QTY_MIN}-${BUFF_QTY_MAX}B per code, up to ${BUFF_MAX_LINES} codes (one per line)`,
    '• You see the exact price before paying',
    '• Tokens arrive in about 1-2 minutes',
    '• Failed orders are refunded to your wallet automatically',
    '',
    `💰 Wallet: <b>$${Number(ctx.user.balance ?? 0).toFixed(2)}</b>`,
  ].join('\n');
  const kb = new InlineKeyboard()
    .text('📜 My Buff Orders', 'buff:my')
    .row()
    .text('⬅️ Back', 'shop:home')
    .text('🏠 Home', 'main:open');
  await showOrEdit(ctx, html, kb);
}

export function registerBuff(bot: Composer<AppCtx>): void {
  bot.callbackQuery('buff:open', async (ctx) => {
    if (!getBuffEnabled()) {
      await ctx.answerCallbackQuery({ text: 'Buff Token is not available right now.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showBuffHome(ctx);
  });

  bot.callbackQuery('buff:my', async (ctx) => {
    await ctx.answerCallbackQuery();
    let rows: Awaited<ReturnType<typeof listBuffOrders>> = [];
    try {
      rows = await listBuffOrders({ userId: ctx.user.telegram_id, limit: 10 });
    } catch (err) {
      if (!isBuffMigrationError(err)) logger.warn({ err }, 'buff my orders failed');
    }
    const lines = ['📜 <b>My Buff Orders</b>', ''];
    if (rows.length === 0) lines.push('<i>No Buff orders yet.</i>');
    for (const o of rows) {
      const codes = o.orders_text.split('\n').map((l) => escapeAttr(l)).join(', ');
      lines.push(
        `<b>#B${o.id}</b> · ${o.total_qty}B · $${Number(o.price_usdt).toFixed(2)} · ${buffStatusLabel(o.status)}`,
        `<code>${codes}</code>`,
      );
    }
    const kb = new InlineKeyboard().text('⬅️ Back', 'buff:open').text('🏠 Home', 'main:open');
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
    const lines = [
      '🧾 <b>Buff Token order preview</b>',
      '',
      ...quote.lines.map((l) => `• <code>${escapeAttr(l.code)}</code> → <b>${l.qty}B</b>`),
      '',
      `Total: <b>${quote.totalQty}B tokens</b>`,
      `Price: <b>$${quote.priceUsdt.toFixed(2)}</b>`,
      `Wallet: $${balance.toFixed(2)}`,
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
          ? '✅ <b>Buff Token order placed!</b>'
          : '⏳ <b>Buff Token order received</b> — it is being checked.';
      await ctx.reply(
        [
          head,
          '',
          `Order: <b>#B${res.order.id}</b>`,
          `Paid: <b>$${res.priceUsdt.toFixed(2)}</b>`,
          res.balanceAfter !== null ? `Wallet: $${res.balanceAfter.toFixed(2)}` : '',
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
