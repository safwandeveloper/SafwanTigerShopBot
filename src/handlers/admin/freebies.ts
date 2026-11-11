/**
 * Admin → 🎁 Freebies: create / edit / delete freebies, manage the item
 * pool, limits, button chrome and view claims.
 */
import { InlineKeyboard, type Composer } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import {
  addFreebieItems,
  clearUnclaimedFreebieItems,
  countFreebieClaims,
  createFreebie,
  deleteFreebie,
  freebieRemaining,
  getFreebie,
  listFreebieClaims,
  listFreebies,
  updateFreebie,
  type DBFreebie,
} from '../../db/freebies.js';
import { isAdmin } from '../../db/queries.js';
import type { FreebieField } from '../../middleware/session.js';
import type { AppCtx } from '../../middleware/user.js';
import { clampForTelegram, entitiesToHtml, escapeAttr } from '../../services/premium.js';

const COLORS = ['none', 'green', 'blue', 'red'] as const;

const PROMPTS: Record<FreebieField, string> = {
  name: 'Send the freebie <b>name</b>.',
  emoji: 'Send ONE <b>premium emoji</b> for this freebie (send <code>-</code> to use the default).',
  kind: 'Send the <b>kind</b> (e.g. Resources, Method, Account).',
  description: 'Send the <b>description</b>. Formatting and premium emojis are kept. Send <code>-</code> to clear.',
  content:
    'Send the <b>content</b> every claimer receives (text / link). Formatting and premium emojis are kept. Send <code>-</code> to clear.',
  items: 'Send stock <b>items</b>, one per line. Each claim delivers one line.',
  stock: 'Send the <b>stock</b> (number of claims available). Send <code>-</code> for unlimited.',
  limit: 'Send the <b>per-user claim limit</b>. Send <code>0</code> for unlimited.',
  min_refs: 'Send the <b>minimum active referrals</b> needed to claim. Send <code>0</code> to turn off.',
  label: 'Send the <b>button label</b> shown in the list. Send <code>-</code> to use the name.',
  icon: 'Send ONE <b>premium emoji</b> for the list button icon (send <code>-</code> to use the freebie emoji).',
};

function tgEmoji(id: string | null, fallback = '🎁'): string {
  return id ? `<tg-emoji emoji-id="${escapeAttr(id)}">${fallback}</tg-emoji>` : fallback;
}

async function sendOrEdit(ctx: AppCtx, html: string, kb: InlineKeyboard): Promise<void> {
  const opts = {
    parse_mode: 'HTML' as const,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };
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

async function showList(ctx: AppCtx): Promise<void> {
  ctx.session.adminFlow = undefined;
  const freebies = await listFreebies(false);
  const kb = new InlineKeyboard().text('➕ Add Freebie', 'adm:fb:add').row();
  for (const f of freebies) {
    kb.text(`${f.active ? '🟢' : '🔴'} ${f.name}`.slice(0, 64), `adm:fb:v:${f.id}`).row();
  }
  kb.text('⬅️ Back', 'adm:root');
  const html =
    `🎁 <b>Freebies</b>\n\n` +
    `Users see active freebies in <b>Refer &amp; Earn → Freebies</b>.\n` +
    `Total: <b>${freebies.length}</b> (🟢 on / 🔴 off)`;
  await sendOrEdit(ctx, html, kb);
}

async function showDetail(ctx: AppCtx, id: number): Promise<void> {
  ctx.session.adminFlow = undefined;
  const f = await getFreebie(id);
  if (!f) {
    await showList(ctx);
    return;
  }
  const [remaining, claims] = await Promise.all([freebieRemaining(f), countFreebieClaims(f.id)]);
  const isItems = f.delivery_mode === 'items';
  const preview = (s: string | null) => {
    const v = (s ?? '').replace(/<[^>]+>/g, '').trim();
    return v ? escapeAttr(v.length > 120 ? `${v.slice(0, 120)}…` : v) : '<i>(empty)</i>';
  };
  const html = clampForTelegram(
    [
      `${tgEmoji(f.emoji_id)} <b>${escapeAttr(f.name)}</b>  ${f.active ? '🟢 ON' : '🔴 OFF'}`,
      '',
      `<b>Kind:</b> ${escapeAttr(f.kind)}`,
      `<b>Delivery:</b> ${isItems ? 'Stock items (1 per claim)' : 'Same content for everyone'}`,
      `<b>Stock left:</b> ${remaining === null ? '∞ unlimited' : remaining}`,
      `<b>Per-user limit:</b> ${f.per_user_limit > 0 ? f.per_user_limit : '∞ unlimited'}`,
      `<b>Min refs:</b> ${f.min_refs > 0 ? f.min_refs : 'off'}`,
      `<b>Total claims:</b> ${claims}`,
      `<b>Button:</b> ${tgEmoji(f.button_icon_id ?? f.emoji_id)} ${escapeAttr(f.button_label?.trim() || f.name)} · color ${f.button_color}`,
      '',
      `<b>Description:</b> ${preview(f.description)}`,
      isItems ? '' : `<b>Content:</b> ${preview(f.content)}`,
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n'),
  );
  const e = (field: FreebieField) => `adm:fb:e:${f.id}:${field}`;
  const kb = new InlineKeyboard()
    .text('✏️ Name', e('name'))
    .text('😀 Emoji', e('emoji'))
    .text('🏷 Kind', e('kind'))
    .row()
    .text('📄 Description', e('description'))
    .text(`🔁 Mode: ${isItems ? 'Items' : 'Content'}`, `adm:fb:mode:${f.id}`)
    .row();
  if (isItems) {
    kb.text('➕ Add Items', e('items')).text('🧹 Clear Unclaimed', `adm:fb:clr:${f.id}`).row();
  } else {
    kb.text('📦 Content', e('content')).text('🔢 Stock', e('stock')).row();
  }
  kb.text('👤 Per-user Limit', e('limit'))
    .text('🎫 Min Refs', e('min_refs'))
    .row()
    .text('🔤 Button Label', e('label'))
    .text('🎨 Color', `adm:fb:color:${f.id}`)
    .text('✨ Icon', e('icon'))
    .row()
    .text(f.active ? '🔴 Turn OFF' : '🟢 Turn ON', `adm:fb:tog:${f.id}`)
    .text('📊 Claims', `adm:fb:cl:${f.id}`)
    .row()
    .text('🗑 Delete', `adm:fb:del:${f.id}`)
    .text('⬅️ Back', 'adm:fb');
  await sendOrEdit(ctx, html, kb);
}

function firstCustomEmojiId(entities: ReadonlyArray<MessageEntity> | undefined): string | null {
  const ent = entities?.find((x) => x.type === 'custom_emoji');
  return ent && 'custom_emoji_id' in ent ? ent.custom_emoji_id : null;
}

function parseCount(text: string): number | null {
  return /^\d{1,7}$/.test(text) ? Number(text) : null;
}

/** Returns an error message, or null when the value was saved. */
async function applyField(
  f: DBFreebie,
  field: FreebieField,
  text: string,
  entities: ReadonlyArray<MessageEntity> | undefined,
): Promise<string | null> {
  const raw = text;
  text = text.trim();
  const clear = text === '-';
  switch (field) {
    case 'name':
      if (!text || text.length > 64) return 'Name must be 1–64 characters.';
      await updateFreebie(f.id, { name: text });
      return null;
    case 'kind':
      if (!text || text.length > 40) return 'Kind must be 1–40 characters.';
      await updateFreebie(f.id, { kind: text });
      return null;
    case 'label':
      if (text.length > 48) return 'Label must be at most 48 characters.';
      await updateFreebie(f.id, { button_label: clear ? null : text });
      return null;
    case 'emoji':
    case 'icon': {
      const id = clear ? null : firstCustomEmojiId(entities);
      if (!clear && !id) return 'That is not a premium emoji. Send one premium (custom) emoji.';
      await updateFreebie(f.id, field === 'emoji' ? { emoji_id: id } : { button_icon_id: id });
      return null;
    }
    case 'description':
    case 'content': {
      const html = clear ? null : entitiesToHtml(raw, entities).trim();
      await updateFreebie(f.id, field === 'description' ? { description: html } : { content: html });
      return null;
    }
    case 'items': {
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return 'Send at least one line.';
      await addFreebieItems(f.id, lines);
      return null;
    }
    case 'stock': {
      if (clear) {
        await updateFreebie(f.id, { stock: null });
        return null;
      }
      const n = parseCount(text);
      if (n === null) return 'Send a whole number, or - for unlimited.';
      await updateFreebie(f.id, { stock: n });
      return null;
    }
    case 'limit':
    case 'min_refs': {
      const n = parseCount(text);
      if (n === null) return 'Send a whole number (0 = off/unlimited).';
      await updateFreebie(f.id, field === 'limit' ? { per_user_limit: n } : { min_refs: n });
      return null;
    }
  }
}

export function registerFreebiesAdmin(adminBot: Composer<AppCtx>): void {
  adminBot.callbackQuery('adm:fb', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showList(ctx);
  });

  adminBot.callbackQuery(/^adm:fb:v:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDetail(ctx, Number(ctx.match[1]));
  });

  adminBot.callbackQuery('adm:fb:add', async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.adminFlow = { type: 'freebie_edit', step: 'value', data: { freebie_id: null, field: 'name' } };
    await sendOrEdit(
      ctx,
      `➕ <b>New Freebie</b>\n\n${PROMPTS.name}\n\n<i>It starts OFF — turn it ON after setting it up.</i>`,
      new InlineKeyboard().text('❌ Cancel', 'adm:fb'),
    );
  });

  adminBot.callbackQuery(/^adm:fb:e:(\d+):([a-z_]+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const field = ctx.match[2] as FreebieField;
    if (!(field in PROMPTS)) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.adminFlow = { type: 'freebie_edit', step: 'value', data: { freebie_id: id, field } };
    await sendOrEdit(ctx, PROMPTS[field], new InlineKeyboard().text('❌ Cancel', `adm:fb:v:${id}`));
  });

  adminBot.callbackQuery(/^adm:fb:mode:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const f = await getFreebie(id);
    if (f) await updateFreebie(id, { delivery_mode: f.delivery_mode === 'items' ? 'content' : 'items' });
    await ctx.answerCallbackQuery({ text: 'Mode switched' });
    await showDetail(ctx, id);
  });

  adminBot.callbackQuery(/^adm:fb:color:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const f = await getFreebie(id);
    if (f) {
      const idx = COLORS.indexOf(f.button_color as (typeof COLORS)[number]);
      await updateFreebie(id, { button_color: COLORS[(idx + 1) % COLORS.length] });
    }
    await ctx.answerCallbackQuery();
    await showDetail(ctx, id);
  });

  adminBot.callbackQuery(/^adm:fb:tog:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const f = await getFreebie(id);
    if (f) await updateFreebie(id, { active: !f.active });
    await ctx.answerCallbackQuery({ text: f?.active ? 'Turned OFF' : 'Turned ON' });
    await showDetail(ctx, id);
  });

  adminBot.callbackQuery(/^adm:fb:clr:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const removed = await clearUnclaimedFreebieItems(id);
    await ctx.answerCallbackQuery({ text: `Removed ${removed} unclaimed item(s)` });
    await showDetail(ctx, id);
  });

  adminBot.callbackQuery(/^adm:fb:cl:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]);
    const [f, total, claims] = await Promise.all([
      getFreebie(id),
      countFreebieClaims(id),
      listFreebieClaims(id, 25),
    ]);
    if (!f) {
      await showList(ctx);
      return;
    }
    const perUser = new Map<number, number>();
    for (const c of claims) perUser.set(c.user_id, (perUser.get(c.user_id) ?? 0) + 1);
    const rows = claims.map(
      (c) => `• <code>${c.user_id}</code> — ${c.claimed_at.slice(0, 16).replace('T', ' ')}`,
    );
    const html = clampForTelegram(
      `📊 <b>Claims: ${escapeAttr(f.name)}</b>\n\nTotal claims: <b>${total}</b>\n` +
        `Users in latest ${claims.length}: <b>${perUser.size}</b>\n\n` +
        (rows.length ? rows.join('\n') : '<i>No claims yet.</i>'),
    );
    await sendOrEdit(ctx, html, new InlineKeyboard().text('⬅️ Back', `adm:fb:v:${id}`));
  });

  adminBot.callbackQuery(/^adm:fb:del:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]);
    await sendOrEdit(
      ctx,
      '🗑 <b>Delete this freebie?</b>\n\nIts items and claim history will be removed too. Tip: turn it OFF instead to keep history.',
      new InlineKeyboard().text('✅ Yes, delete', `adm:fb:delok:${id}`).text('❌ No', `adm:fb:v:${id}`),
    );
  });

  adminBot.callbackQuery(/^adm:fb:delok:(\d+)$/, async (ctx) => {
    await deleteFreebie(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: 'Deleted' });
    await showList(ctx);
  });

  adminBot.on('message:text', async (ctx, next) => {
    const flow = ctx.session.adminFlow;
    if (flow?.type !== 'freebie_edit') return next();
    if (!ctx.from || !(await isAdmin(ctx.from.id))) return next();
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.adminFlow = undefined;
      return next();
    }
    const { freebie_id, field } = flow.data;
    let f: DBFreebie | null;
    if (freebie_id === null) {
      if (!text || text.length > 64) {
        await ctx.reply('Name must be 1–64 characters. Try again.');
        return;
      }
      f = await createFreebie(text);
      await showDetail(ctx, f.id);
      return;
    }
    f = await getFreebie(freebie_id);
    if (!f) {
      ctx.session.adminFlow = undefined;
      await ctx.reply('Freebie not found.');
      return;
    }
    const err = await applyField(f, field, ctx.message.text, ctx.message.entities);
    if (err) {
      await ctx.reply(`⚠️ ${err}`);
      return;
    }
    await ctx.reply('✅ Saved.');
    await showDetail(ctx, f.id);
  });
}
