/**
 * Refer & Earn → Freebies: list, detail and claim screens.
 */
import { InlineKeyboard, type Composer } from 'grammy';
import { colorModeToStyle, type ColorMode } from '../../config/index.js';
import { countReferralsAfter } from '../db/queries.js';
import {
  claimFreebie,
  countFreebieClaims,
  FreebieClaimFailed,
  freebieRemaining,
  getFreebie,
  listFreebies,
  type DBFreebie,
} from '../db/freebies.js';
import { logger } from '../logger.js';
import { isForceJoinSatisfied, sendForceJoinPrompt } from '../middleware/forceJoin.js';
import type { AppCtx } from '../middleware/user.js';
import { inlineBtn, isButtonChromeEnabled } from '../keyboards/helpers.js';
import {
  clampForTelegram,
  escapeAttr,
  renderHtmlTemplate,
  renderMdHtml,
} from '../services/premium.js';
import { getEmoji } from '../services/settings.js';

function emojiIdOf(key: string): string | undefined {
  const spec = getEmoji(key);
  return typeof spec === 'object' ? spec.custom_emoji_id : undefined;
}

function freebieIconMarker(f: DBFreebie): string {
  const id = f.emoji_id ?? emojiIdOf('freebie_default');
  return id ? `{{ce:${id}|🎁}}` : '🎁';
}

function navRow(kb: InlineKeyboard, lang: AppCtx['lang'], backCb: string): InlineKeyboard {
  inlineBtn(kb, lang, 'back', backCb);
  inlineBtn(kb, lang, 'home', 'main:open');
  return kb;
}

async function showOrEdit(ctx: AppCtx, html: string, reply_markup: InlineKeyboard): Promise<void> {
  const opts = {
    parse_mode: 'HTML' as const,
    reply_markup,
    link_preview_options: { is_disabled: true },
  };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(html, opts);
      return;
    } catch (err) {
      if (/message is not modified/i.test(String((err as Error)?.message))) return;
      logger.warn({ err }, 'freebies: edit failed, sending new message');
    }
  }
  await ctx.reply(html, opts);
}

export async function showFreebiesList(ctx: AppCtx): Promise<void> {
  const freebies = await listFreebies(true);
  const kb = new InlineKeyboard();
  for (const f of freebies) {
    const remaining = await freebieRemaining(f);
    const price = f.min_refs > 0 ? `${f.min_refs} Refs` : 'Free';
    const label = `${f.button_label?.trim() || f.name} | ${price} | ${remaining === null ? '∞' : remaining}`;
    kb.text(label.slice(0, 64), `fb:v:${f.id}`);
    if (isButtonChromeEnabled()) {
      const iconId = f.button_icon_id ?? f.emoji_id ?? emojiIdOf('freebie_default');
      if (iconId) kb.icon(iconId);
      const style = colorModeToStyle(f.button_color as ColorMode);
      if (style) kb.style(style);
    }
    kb.row();
  }
  navRow(kb, ctx.lang, 'main:open');
  const body = freebies.length
    ? ctx.t('freebie.list.body', { count: freebies.length })
    : ctx.t('freebie.list.empty');
  await showOrEdit(ctx, renderMdHtml(`${ctx.t('freebie.list.title')}\n\n${body}`), kb);
}

export async function showFreebieDetail(ctx: AppCtx, id: number): Promise<void> {
  const f = await getFreebie(id);
  if (!f || !f.active) {
    await showFreebiesList(ctx);
    return;
  }
  const [remaining, used, refs] = await Promise.all([
    freebieRemaining(f),
    countFreebieClaims(f.id, ctx.user.telegram_id),
    f.min_refs > 0 ? countReferralsAfter(ctx.user.telegram_id, f.created_at) : Promise.resolve(0),
  ]);
  const stockText = remaining === null ? 'Unlimited' : remaining > 0 ? String(remaining) : 'Out of stock';
  const limitText = f.per_user_limit > 0 ? String(f.per_user_limit) : '∞';
  const lines = [
    `${freebieIconMarker(f)}  <b>${escapeAttr(f.name)}</b>`,
    '',
    `{freebie_kind}  <b>Kind:</b> ${escapeAttr(f.kind)}`,
    `{freebie_stock}  <b>Stock:</b> ${stockText}`,
    `{freebie_claims}  <b>Your claims:</b> ${used} / ${limitText}`,
  ];
  if (f.min_refs > 0) lines.push(`{freebie_refs}  <b>Required refs:</b> ${f.min_refs}/${refs}`);
  if (f.description?.trim()) {
    lines.push('', `{freebie_desc}  <b>Description</b>`, `<blockquote>${f.description.trim()}</blockquote>`);
  }
  if (f.min_refs > 0) {
    const friends = f.min_refs === 1 ? 'new friend' : 'new friends';
    lines.push(
      '',
      '{freebie_unlock}  <b>Unlock conditions:</b>',
      `• Invite ${f.min_refs} ${friends} (since this freebie went live)`,
    );
  }
  lines.push('', '{freebie_free_end}  <i>Free — no payment needed.</i>');
  const kb = new InlineKeyboard();
  inlineBtn(kb, ctx.lang, 'freebie_claim', `fb:c:${f.id}`);
  kb.row();
  navRow(kb, ctx.lang, 'fb:list');
  await showOrEdit(ctx, clampForTelegram(renderHtmlTemplate(lines.join('\n'))), kb);
}

function deliveredHtml(f: DBFreebie, delivered: string | null): string {
  const body = (delivered ?? '').trim();
  const content = !body
    ? '<i>Contact support to receive this freebie.</i>'
    : f.delivery_mode === 'items'
      ? `<code>${escapeAttr(body)}</code>`
      : `<blockquote>${body}</blockquote>`;
  return clampForTelegram(
    renderHtmlTemplate(
      [
        `{freebie_ok}  <b>Claimed:</b> ${freebieIconMarker(f)} ${escapeAttr(f.name)}`,
        '',
        `{freebie_item}  <b>Your freebie:</b>`,
        content,
      ].join('\n'),
    ),
  );
}

async function claim(ctx: AppCtx, id: number): Promise<void> {
  const f = await getFreebie(id);
  if (!f || !f.active) {
    await ctx.answerCallbackQuery({ text: ctx.t('freebie.inactive'), show_alert: true });
    return;
  }
  if (!(await isForceJoinSatisfied(ctx))) {
    await ctx.answerCallbackQuery();
    await sendForceJoinPrompt(ctx);
    return;
  }
  if (f.min_refs > 0) {
    const have = await countReferralsAfter(ctx.user.telegram_id, f.created_at);
    if (have < f.min_refs) {
      await ctx.answerCallbackQuery({
        text: ctx.t('freebie.need_refs', { required: f.min_refs, have }),
        show_alert: true,
      });
      return;
    }
  }
  let delivered: string | null;
  try {
    ({ delivered } = await claimFreebie(f.id, ctx.user.telegram_id));
  } catch (err) {
    const key =
      err instanceof FreebieClaimFailed
        ? err.code === 'FREEBIE_LIMIT'
          ? 'freebie.limit'
          : err.code === 'FREEBIE_OUT'
            ? 'freebie.out'
            : 'freebie.inactive'
        : 'freebie.error';
    if (!(err instanceof FreebieClaimFailed)) logger.error({ err, id }, 'freebie claim failed');
    await ctx.answerCallbackQuery({ text: ctx.t(key), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: '✅' });
  await ctx.reply(deliveredHtml(f, delivered), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  await showFreebieDetail(ctx, f.id).catch((err) =>
    logger.warn({ err, id }, 'freebie detail refresh failed'),
  );
}

export function registerFreebies(bot: Composer<AppCtx>): void {
  bot.callbackQuery('fb:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showFreebiesList(ctx);
  });
  bot.callbackQuery(/^fb:v:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showFreebieDetail(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^fb:c:(\d+)$/, async (ctx) => {
    await claim(ctx, Number(ctx.match[1]));
  });
}
