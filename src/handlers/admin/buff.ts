/**
 * Admin → 🚀 Buff Token: ON/OFF, markup, TunVN balance, recent orders
 * and manual refund for orders TunVN could not confirm.
 */
import { InlineKeyboard, type Composer } from 'grammy';
import type { AppCtx } from '../../middleware/user.js';
import {
  adminRefundBuff,
  buffStatusLabel,
  findBuffSource,
  isBuffMigrationError,
  listBuffOrders,
  type DBBuffOrder,
} from '../../services/buff.js';
import { escapeAttr } from '../../services/premium.js';
import {
  getBuffEnabled,
  getBuffMarkupPercent,
  setBuffEnabled,
  setBuffMarkupPercent,
} from '../../services/settings.js';
import { fetchSupplierBalance } from '../../services/supplierApi.js';

async function showBuffAdmin(ctx: AppCtx): Promise<void> {
  const source = await findBuffSource().catch(() => null);
  const balance = source ? await fetchSupplierBalance(source).catch(() => null) : null;
  let orders: DBBuffOrder[] = [];
  let dbReady = true;
  try {
    orders = await listBuffOrders({ limit: 10 });
  } catch (err) {
    dbReady = !isBuffMigrationError(err);
  }
  const lines = [
    '🚀 <b>Buff Token Muse AI (TunVN)</b>',
    '',
    `Status: <b>${getBuffEnabled() ? '🟢 ON' : '🔴 OFF'}</b>`,
    `Markup: <b>${getBuffMarkupPercent()}%</b> over TunVN price`,
    `Supplier: <b>${source ? `${escapeAttr(source.name)} (#${source.id})` : '❌ No enabled TunVN supplier found'}</b>`,
    `TunVN balance: <b>${balance === null ? 'unknown' : `$${balance.toFixed(2)}`}</b>`,
    `Database: <b>${dbReady ? 'ready' : '❌ run migration 0050_buff_profit_lock.sql'}</b>`,
    '',
    '<b>Recent orders</b>',
  ];
  if (orders.length === 0) lines.push('<i>None yet.</i>');
  const kb = new InlineKeyboard()
    .text(getBuffEnabled() ? '🔴 Turn OFF' : '🟢 Turn ON', 'adm:buff:tog')
    .row()
    .text('➖ 5%', 'adm:buff:m:-5')
    .text(`Markup ${getBuffMarkupPercent()}%`, 'adm:buff')
    .text('➕ 5%', 'adm:buff:m:5')
    .row();
  for (const o of orders) {
    lines.push(
      `#B${o.id} · <a href="tg://user?id=${o.user_id}">${o.user_id}</a> · ${o.channel} · ${o.total_qty}B · $${Number(o.price_usdt).toFixed(2)} (cost $${Number(o.supplier_cost_usdt ?? 0).toFixed(2)}) · ${buffStatusLabel(o.status)}`,
    );
    if (o.status === 'needs_check' && o.channel !== 'freebie') {
      kb.text(`↩️ Refund #B${o.id}`, `adm:buff:rf:${o.id}`).row();
    }
  }
  lines.push('', '<i>"Being checked" = TunVN took the order but could not confirm it. Check TunVN first, refund only if it really failed.</i>');
  kb.text('🔄 Refresh', 'adm:buff').text('⬅️ Back', 'adm:back');
  const html = lines.join('\n').slice(0, 4000);
  const opts = { parse_mode: 'HTML' as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(html, opts);
      return;
    } catch (err) {
      if (/message is not modified/i.test(String((err as Error)?.message))) return;
    }
  }
  await ctx.reply(html, opts);
}

export function registerBuffAdmin(adminBot: Composer<AppCtx>): void {
  adminBot.callbackQuery('adm:buff', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBuffAdmin(ctx);
  });
  adminBot.callbackQuery('adm:buff:tog', async (ctx) => {
    await setBuffEnabled(!getBuffEnabled(), ctx.from.id);
    await ctx.answerCallbackQuery({ text: getBuffEnabled() ? 'Buff Token ON' : 'Buff Token OFF' });
    await showBuffAdmin(ctx);
  });
  adminBot.callbackQuery(/^adm:buff:m:(-?\d+)$/, async (ctx) => {
    const next = await setBuffMarkupPercent(getBuffMarkupPercent() + Number(ctx.match[1]), ctx.from.id);
    await ctx.answerCallbackQuery({ text: `Markup ${next}%` });
    await showBuffAdmin(ctx);
  });
  adminBot.callbackQuery(/^adm:buff:rf:(\d+)$/, async (ctx) => {
    const refunded = await adminRefundBuff(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({
      text: refunded > 0 ? `Refunded $${refunded.toFixed(2)}` : 'Nothing to refund.',
      show_alert: true,
    });
    await showBuffAdmin(ctx);
  });
}
