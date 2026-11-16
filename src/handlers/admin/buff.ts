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
import { entitiesToHtml, escapeAttr } from '../../services/premium.js';
import type { MessageEntity } from 'grammy/types';
import { isAdmin } from '../../db/queries.js';
import {
  getBuffDescription,
  getBuffEmojiSpec,
  getBuffEnabled,
  getBuffMarkupPercent,
  getBuffName,
  getBuffPosition,
  getBuffUnitPrice,
  getBuffWarranty,
  setBuffDescription,
  setBuffEmoji,
  setBuffEnabled,
  setBuffMarkupPercent,
  setBuffName,
  setBuffPosition,
  setBuffWarranty,
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
  const spec = getBuffEmojiSpec();
  const iconTxt = typeof spec === 'object' && spec.custom_emoji_id ? 'premium emoji' : String(spec);
  const unit = getBuffUnitPrice();
  const lines = [
    '🚀 <b>Buff Token Muse AI (TunVN)</b>',
    '',
    `<b>Card name:</b> ${escapeAttr(getBuffName())} · <b>Icon:</b> ${escapeAttr(iconTxt)}`,
    `<b>Price/1B:</b> ${unit ? `$${unit.toFixed(2)}` : '<i>shown after first order</i>'} · <b>Shop row:</b> ${getBuffPosition()}`,
    `<b>Warranty:</b> ${escapeAttr(getBuffWarranty())}`,
    `<b>Description:</b> ${escapeAttr(getBuffDescription() || '(none)')}`,
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
  kb.text('✏️ Name', 'adm:buff:f:name')
    .text('✨ Icon', 'adm:buff:f:emoji')
    .row()
    .text('📄 Description', 'adm:buff:f:description')
    .text('🛡 Warranty', 'adm:buff:f:warranty')
    .row()
    .text(`↕️ Shop row: ${getBuffPosition() === 'top' ? 'Top' : 'Bottom'}`, 'adm:buff:pos')
    .row()
    .text('🔄 Refresh', 'adm:buff')
    .text('⬅️ Back', 'adm:back');
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
  const PROMPTS: Record<string, string> = {
    name: 'Send the <b>name</b> shown on the Buff card and shop button (e.g. Buff Token Muse AI).',
    emoji: 'Send ONE <b>premium emoji</b> for the Buff card icon (or any unicode emoji).',
    description:
      'Send the <b>description</b> shown under the Buff card title. Formatting and premium emojis are kept. Send <code>-</code> to clear.',
    warranty: 'Send the <b>warranty</b> line (e.g. "Tokens in ~2 min or auto-refund").',
  };

  adminBot.callbackQuery(/^adm:buff:f:(name|emoji|description|warranty)$/, async (ctx) => {
    const field = ctx.match[1] as 'name' | 'emoji' | 'description' | 'warranty';
    ctx.session.adminFlow = { type: 'buff_edit', step: 'value', data: { field } };
    await ctx.answerCallbackQuery();
    await ctx.reply(PROMPTS[field] ?? 'Send the new value.', { parse_mode: 'HTML' });
  });

  adminBot.callbackQuery('adm:buff:pos', async (ctx) => {
    const next = getBuffPosition() === 'top' ? 'bottom' : 'top';
    await setBuffPosition(next, ctx.from.id);
    await ctx.answerCallbackQuery({ text: `Shop row: ${next}` });
    await showBuffAdmin(ctx);
  });

  adminBot.on('message:text', async (ctx, next) => {
    const flow = ctx.session.adminFlow;
    if (!flow || flow.type !== 'buff_edit') return next();
    if (!ctx.from || !(await isAdmin(ctx.from.id))) return next();
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.adminFlow = undefined;
      return next();
    }
    ctx.session.adminFlow = undefined;
    const { field } = flow.data;
    if (field === 'name') {
      if (!text || text.length > 60) {
        await ctx.reply('⚠️ Name must be 1-60 characters.');
        return;
      }
      await setBuffName(text, ctx.from.id);
    } else if (field === 'description') {
      await setBuffDescription(text === '-' ? '' : entitiesToHtml(ctx.message.text, ctx.message.entities ?? []), ctx.from.id);
    } else if (field === 'warranty') {
      await setBuffWarranty(text, ctx.from.id);
    } else {
      const ent = ctx.message.entities?.find((e: MessageEntity) => e.type === 'custom_emoji');
      const id = ent && 'custom_emoji_id' in ent ? ent.custom_emoji_id : undefined;
      await setBuffEmoji(text.slice(0, 4) || '🚀', id, ctx.from.id);
    }
    await ctx.reply('✅ Saved.');
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
