/**
 * Buff Token (Muse AI) via TunVN. The customer sends `INVITE_CODE QTY`
 * lines, we price them with `/api/buff/check`, charge the wallet, then
 * place `/api/buff/order` with the owner's TunVN USDT balance. Anything
 * TunVN rejects is refunded; batches are polled until they finish and
 * failed lines are refunded too.
 */
import type { Api } from 'grammy';
import { findUserById, listSupplierApiSources } from '../db/queries.js';
import { supabase } from '../db/supabase.js';
import { logger } from '../logger.js';
import type { DBSupplierApiSource } from '../types.js';
import * as adminLog from './adminLog.js';
import { getBuffEnabled, getBuffMarkupPercent, setBuffUnitPrice } from './settings.js';
import { supplierRequestRaw } from './supplierApi.js';
import { charge, credit } from './wallet.js';

export const BUFF_QTY_MIN = 1;
export const BUFF_QTY_MAX = 30;
export const BUFF_MAX_LINES = 10;
const POLL_MS = 60_000;
const POLL_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type BuffChannel = 'bot' | 'api' | 'freebie';
export type BuffStatus = 'pending' | 'placed' | 'done' | 'failed' | 'refunded' | 'partial_refund' | 'needs_check';

export type DBBuffOrder = {
  id: number;
  user_id: number;
  channel: BuffChannel;
  supplier_id: number | null;
  order_id: number | null;
  freebie_claim_id: number | null;
  orders_text: string;
  total_qty: number;
  supplier_cost_usdt: number | null;
  price_usdt: number;
  refunded_usdt: number;
  status: BuffStatus;
  batch_id: string | null;
  supplier_response: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type BuffLine = { code: string; qty: number };

export type BuffQuote = {
  ordersText: string;
  lines: BuffLine[];
  totalQty: number;
  costUsdt: number;
  priceUsdt: number;
  fundable: boolean;
};

export class BuffError extends Error {
  constructor(
    public code:
      | 'disabled'
      | 'not_configured'
      | 'invalid'
      | 'unavailable'
      | 'price_changed'
      | 'insufficient_balance'
      | 'supplier_rejected'
      | 'internal',
    message: string,
    public httpStatus = 400,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function isBuffMigrationError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  return /buff_orders|release_freebie_claim|buff_qty/i.test(msg) && /(does not exist|schema cache|could not find)/i.test(msg);
}

const money = (n: number) => Number(n.toFixed(4));

export function buffSellPrice(costUsdt: number, markupPercent = getBuffMarkupPercent()): number {
  const raw = costUsdt * (1 + markupPercent / 100);
  return Math.max(0.01, Math.ceil(raw * 100 - 1e-6) / 100);
}

/** Parse `CODE 20` lines (space, colon or comma separated). Returns an error string on bad input. */
export function parseBuffText(text: string, fixedQty?: number): { lines: BuffLine[]; ordersText: string } | string {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (rows.length === 0) return 'Send at least one line: INVITE_CODE QUANTITY';
  if (rows.length > BUFF_MAX_LINES) return `Max ${BUFF_MAX_LINES} lines per order.`;
  if (fixedQty !== undefined && rows.length !== 1) return 'Send only one invite code.';
  const lines: BuffLine[] = [];
  for (const row of rows) {
    const parts = row.split(/[\s,:;]+/).filter(Boolean);
    const code = parts[0] ?? '';
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) return `Invalid invite code: ${code.slice(0, 32) || '(empty)'}`;
    let qty: number;
    if (fixedQty !== undefined) {
      if (parts.length > 1) return 'Send only your invite code (the amount is fixed).';
      qty = fixedQty;
    } else {
      if (parts.length !== 2) return `Use: INVITE_CODE QUANTITY (e.g. ${code} 20)`;
      qty = Number(parts[1]);
      if (!Number.isInteger(qty) || qty < BUFF_QTY_MIN || qty > BUFF_QTY_MAX) {
        return `Quantity must be ${BUFF_QTY_MIN}-${BUFF_QTY_MAX} (billion tokens) per code.`;
      }
    }
    lines.push({ code, qty });
  }
  return { lines, ordersText: lines.map((l) => `${l.code} ${l.qty}`).join('\n') };
}

export async function findBuffSource(): Promise<DBSupplierApiSource | null> {
  const { rows } = await listSupplierApiSources(0, 100);
  return rows.find((s) => s.enabled && /tunvnmmo/i.test(s.base_url)) ?? null;
}

async function requireSource(): Promise<DBSupplierApiSource> {
  const source = await findBuffSource().catch(() => null);
  if (!source) throw new BuffError('not_configured', 'Buff Token is not available right now.', 503);
  return source;
}

function supplierMessage(json: Record<string, unknown>, status: number): string {
  for (const k of ['error', 'message', 'detail', 'msg']) {
    const v = json[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
  }
  return `HTTP ${status}`;
}

export async function quoteBuff(ordersText: string, fixedQty?: number): Promise<BuffQuote> {
  const parsed = parseBuffText(ordersText, fixedQty);
  if (typeof parsed === 'string') throw new BuffError('invalid', parsed);
  const source = await requireSource();
  const { status, json } = await supplierRequestRaw(source, '/api/buff/check', 'POST', {
    orders_text: parsed.ordersText,
  });
  if (status >= 500 || status === 429) {
    throw new BuffError('unavailable', 'Buff service is busy. Please try again in a minute.', 503);
  }
  if (status !== 200 || json.success !== true) {
    throw new BuffError('invalid', supplierMessage(json, status));
  }
  const breakdown = Array.isArray(json.orders_breakdown) ? (json.orders_breakdown as Record<string, unknown>[]) : [];
  const bad = breakdown.filter((b) => b.valid === false);
  if (bad.length > 0) {
    const codes = bad.map((b) => String(b.invite_code ?? b.line_no ?? '?')).join(', ');
    throw new BuffError('invalid', `Invalid invite code: ${codes}`);
  }
  const cost = Number(json.sell_price_usdt);
  if (!Number.isFinite(cost) || cost <= 0) throw new BuffError('unavailable', 'Buff price unavailable. Try again later.', 503);
  const totalQty = parsed.lines.reduce((a, l) => a + l.qty, 0);
  const price = buffSellPrice(cost);
  if (totalQty > 0) void setBuffUnitPrice(price / totalQty).catch(() => undefined);
  return {
    ordersText: parsed.ordersText,
    lines: parsed.lines,
    totalQty,
    costUsdt: money(cost),
    priceUsdt: price,
    fundable: json.fundable !== false,
  };
}

async function insertBuffOrder(row: Partial<DBBuffOrder>): Promise<DBBuffOrder> {
  const { data, error } = await supabase.from('buff_orders').insert(row).select('*').single();
  if (error) throw error;
  return data as DBBuffOrder;
}

export async function updateBuffOrder(id: number, patch: Partial<DBBuffOrder>): Promise<void> {
  const { error } = await supabase
    .from('buff_orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) logger.error({ err: error, id }, 'buff order update failed');
}

export async function getBuffOrder(id: number): Promise<DBBuffOrder | null> {
  const { data, error } = await supabase.from('buff_orders').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as DBBuffOrder | null) ?? null;
}

export async function listBuffOrders(opts: { userId?: number; limit?: number } = {}): Promise<DBBuffOrder[]> {
  let q = supabase.from('buff_orders').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 10);
  if (opts.userId !== undefined) q = q.eq('user_id', opts.userId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as DBBuffOrder[]) ?? [];
}

async function refundBuff(order: DBBuffOrder, amount: number, reason: string): Promise<number> {
  const amt = money(Math.min(amount, Number(order.price_usdt) - Number(order.refunded_usdt ?? 0)));
  if (order.channel === 'freebie' || amt <= 0) return 0;
  await credit(order.user_id, amt, `buff_refund:${order.id}:${reason}`, 'refund');
  return amt;
}

export type BuffPlaceResult = {
  order: DBBuffOrder;
  status: 'placed' | 'needs_check';
  priceUsdt: number;
  balanceAfter: number | null;
};

/**
 * Charge (unless free) and place a Buff order. Throws `BuffError` when
 * TunVN rejects it; the wallet is already refunded at that point.
 */
export async function placeBuffOrder(args: {
  api: Api;
  userId: number;
  ordersText: string;
  channel: BuffChannel;
  chargeUser: boolean;
  maxPriceUsdt?: number;
  fixedQty?: number;
  freebieClaimId?: number | null;
}): Promise<BuffPlaceResult> {
  if (args.channel !== 'freebie' && !getBuffEnabled()) {
    throw new BuffError('disabled', 'Buff Token is turned off right now.', 503);
  }
  const quote = await quoteBuff(args.ordersText, args.fixedQty);
  if (!quote.fundable) throw new BuffError('unavailable', 'Buff service is busy. Please try again later.', 503);
  const price = args.chargeUser ? quote.priceUsdt : 0;
  if (args.maxPriceUsdt !== undefined && price > args.maxPriceUsdt + 1e-9) {
    throw new BuffError('price_changed', `Price changed to $${price.toFixed(2)}. Please confirm again.`, 409, {
      price,
    });
  }
  const source = await requireSource();

  let balanceAfter: number | null = null;
  if (args.chargeUser) {
    const user = await findUserById(args.userId);
    const balance = Number(user?.balance ?? 0);
    if (balance < price) {
      throw new BuffError('insufficient_balance', `Insufficient balance. Need $${price.toFixed(2)}.`, 402, {
        price,
        balance,
      });
    }
  }

  const row = await insertBuffOrder({
    user_id: args.userId,
    channel: args.channel,
    supplier_id: source.id,
    freebie_claim_id: args.freebieClaimId ?? null,
    orders_text: quote.ordersText,
    total_qty: quote.totalQty,
    supplier_cost_usdt: quote.costUsdt,
    price_usdt: price,
    status: 'pending',
  });

  if (args.chargeUser) {
    try {
      const user = await findUserById(args.userId);
      balanceAfter = await charge(args.userId, price, Number(user?.balance ?? 0), `buff_order:${row.id}`);
    } catch (err) {
      await updateBuffOrder(row.id, { status: 'failed', error: 'wallet charge failed' });
      if ((err as { code?: string }).code === 'INSUFFICIENT_FUNDS') {
        throw new BuffError('insufficient_balance', `Insufficient balance. Need $${price.toFixed(2)}.`, 402);
      }
      throw new BuffError('internal', 'Could not charge wallet. Nothing was taken.', 500);
    }
  }

  let status: number;
  let json: Record<string, unknown>;
  try {
    ({ status, json } = await supplierRequestRaw(
      source,
      '/api/buff/order',
      'POST',
      { orders_text: quote.ordersText, currency: 'usdt' },
      60_000,
    ));
  } catch (err) {
    // Network/timeout: TunVN may or may not have charged. Keep the money
    // held and let the admin check instead of refunding blindly.
    const msg = (err as Error)?.message ?? String(err);
    await updateBuffOrder(row.id, { status: 'needs_check', error: msg.slice(0, 300) });
    void notifyAdmin(args.api, row, `No answer from TunVN (${msg}). Check TunVN /api/buff/orders.`);
    return { order: { ...row, status: 'needs_check' }, status: 'needs_check', priceUsdt: price, balanceAfter };
  }

  const batchId = typeof json.batch_id === 'string' ? json.batch_id : null;
  if (status === 202) {
    await updateBuffOrder(row.id, { status: 'needs_check', batch_id: batchId, supplier_response: json });
    void notifyAdmin(args.api, { ...row, batch_id: batchId }, 'TunVN charged but could not confirm yet (202). Bot will keep checking.');
    return { order: { ...row, status: 'needs_check', batch_id: batchId }, status: 'needs_check', priceUsdt: price, balanceAfter };
  }
  if (status === 200 && json.success === true) {
    await updateBuffOrder(row.id, { status: 'placed', batch_id: batchId, supplier_response: json });
    return { order: { ...row, status: 'placed', batch_id: batchId }, status: 'placed', priceUsdt: price, balanceAfter };
  }

  // Any other answer: TunVN charged nothing, so refund in full.
  const reason = supplierMessage(json, status);
  const refunded = await refundBuff(row, price, 'rejected');
  await updateBuffOrder(row.id, {
    status: args.chargeUser ? 'refunded' : 'failed',
    refunded_usdt: refunded,
    supplier_response: json,
    error: reason,
  });
  if (/balance|insufficient|so du|số dư/i.test(reason) || status === 400) {
    void notifyAdmin(args.api, row, `TunVN rejected: ${reason}`);
  }
  throw new BuffError(
    status === 429 || status === 503 ? 'unavailable' : 'supplier_rejected',
    status === 429 || status === 503
      ? 'Buff service is busy. Please try again in a minute.'
      : `Order rejected: ${reason}`,
    status === 429 || status === 503 ? 503 : 502,
    { refunded },
  );
}

async function notifyAdmin(api: Api, order: Pick<DBBuffOrder, 'id' | 'user_id' | 'channel' | 'orders_text' | 'price_usdt'> & { batch_id?: string | null }, text: string): Promise<void> {
  await adminLog
    .logBuffEvent(api, {
      buffOrderId: order.id,
      userId: order.user_id,
      channel: order.channel,
      ordersText: order.orders_text,
      priceUsdt: Number(order.price_usdt),
      batchId: order.batch_id ?? null,
      message: text,
    })
    .catch((err) => logger.warn({ err }, 'buff admin log failed'));
}

/** Admin action: refund whatever is still held on a Buff order and mark it refunded. */
export async function adminRefundBuff(id: number): Promise<number> {
  const order = await getBuffOrder(id);
  if (!order) return 0;
  if (!['needs_check', 'placed', 'pending'].includes(order.status)) return 0;
  const refunded = await refundBuff(order, Number(order.price_usdt), 'admin');
  await updateBuffOrder(id, {
    status: 'refunded',
    refunded_usdt: money(Number(order.refunded_usdt ?? 0) + refunded),
    error: 'refunded by admin',
  });
  return refunded;
}

type StatusLine = { quantity_b?: unknown; status?: unknown; invite_code?: unknown };

async function pollOne(api: Api, source: DBSupplierApiSource, order: DBBuffOrder): Promise<void> {
  if (!order.batch_id) return;
  const { status, json } = await supplierRequestRaw(source, '/api/buff/status', 'GET', { batch_id: order.batch_id });
  if (status !== 200 || json.success !== true || json.is_done !== true) return;
  const lines = (Array.isArray(json.orders) ? json.orders : []) as StatusLine[];
  const failedQty = lines
    .filter((l) => String(l.status) === 'failed')
    .reduce((a, l) => a + Number(l.quantity_b ?? 0), 0);
  const total = Number(order.total_qty) || lines.reduce((a, l) => a + Number(l.quantity_b ?? 0), 0) || 1;
  const failedCodes = lines.filter((l) => String(l.status) === 'failed').map((l) => String(l.invite_code ?? '?'));

  if (failedQty <= 0) {
    await updateBuffOrder(order.id, { status: 'done', supplier_response: json });
    await api
      .sendMessage(order.user_id, `✅ Buff Token order #B${order.id} is done. ${order.total_qty}B tokens were credited to your invite code.`)
      .catch(() => undefined);
    return;
  }
  const allFailed = failedQty >= total;
  const share = allFailed ? Number(order.price_usdt) : money((Number(order.price_usdt) * failedQty) / total);
  const refunded = await refundBuff(order, share, allFailed ? 'failed' : 'partial');
  if (order.channel === 'freebie' && allFailed && order.freebie_claim_id) {
    const { error } = await supabase.rpc('release_freebie_claim', { p_claim_id: order.freebie_claim_id });
    if (error) logger.warn({ err: error, id: order.id }, 'release_freebie_claim failed');
  }
  await updateBuffOrder(order.id, {
    status: allFailed ? (order.channel === 'freebie' ? 'failed' : 'refunded') : 'partial_refund',
    refunded_usdt: money(Number(order.refunded_usdt ?? 0) + refunded),
    supplier_response: json,
    error: `failed codes: ${failedCodes.join(', ')}`,
  });
  const refundText = refunded > 0 ? ` $${refunded.toFixed(2)} was refunded to your wallet.` : '';
  const freebieText = order.channel === 'freebie' && allFailed ? ' Your freebie claim was given back, you can try again.' : '';
  await api
    .sendMessage(
      order.user_id,
      `⚠️ Buff Token order #B${order.id}: ${allFailed ? 'failed' : `${failedQty}B of ${total}B failed`} (${failedCodes.join(', ')}).${refundText}${freebieText}`,
    )
    .catch(() => undefined);
}

export async function pollBuffOrdersOnce(api: Api): Promise<void> {
  const since = new Date(Date.now() - POLL_MAX_AGE_MS).toISOString();
  const { data, error } = await supabase
    .from('buff_orders')
    .select('*')
    .in('status', ['placed', 'needs_check'])
    .not('batch_id', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) {
    if (!isBuffMigrationError(error)) logger.warn({ err: error }, 'buff poll query failed');
    return;
  }
  const rows = (data as DBBuffOrder[]) ?? [];
  if (rows.length === 0) return;
  const source = await findBuffSource().catch(() => null);
  if (!source) return;
  for (const order of rows) {
    await pollOne(api, source, order).catch((err) => logger.warn({ err, id: order.id }, 'buff status poll failed'));
  }
}

let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

export function startBuffStatusLoop(api: Api): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    void pollBuffOrdersOnce(api)
      .catch((err) => logger.warn({ err }, 'buff poll run failed'))
      .finally(() => {
        polling = false;
      });
  }, POLL_MS);
  pollTimer.unref?.();
}

export function buffStatusLabel(status: BuffStatus): string {
  switch (status) {
    case 'pending':
    case 'placed':
      return '⏳ Processing';
    case 'done':
      return '✅ Done';
    case 'refunded':
      return '↩️ Refunded';
    case 'partial_refund':
      return '⚠️ Partly refunded';
    case 'needs_check':
      return '🔎 Being checked';
    default:
      return '❌ Failed';
  }
}
