import type http from 'node:http';
import type { Api } from 'grammy';
import {
  ApiError,
  apiBaseUrl,
  authenticateApiKey,
  getApiStatus,
  listApiProducts,
  placeApiOrder,
} from './resellerApi.js';
import { BuffError, getBuffOrder, isBuffMigrationError, placeBuffOrder, quoteBuff } from './buff.js';
import { getBuffEnabled } from './settings.js';

const BODY_LIMIT_BYTES = 64 * 1024;

type JsonRecord = Record<string, unknown>;

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: JsonRecord,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-api-key',
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readApiKey(req: http.IncomingMessage, url: URL): string {
  const auth = req.headers.authorization ?? '';
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  if (bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();
  const header = req.headers['x-api-key'];
  if (Array.isArray(header)) return header[0]?.trim() ?? '';
  if (typeof header === 'string') return header.trim();
  return url.searchParams.get('api_key')?.trim() ?? '';
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new ApiError(413, 'body_too_large', 'Request body is too large.');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: http.IncomingMessage): Promise<JsonRecord> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  }
}

function buffApiError(err: unknown): ApiError {
  if (err instanceof BuffError) return new ApiError(err.httpStatus, `buff_${err.code}`, err.message);
  if (isBuffMigrationError(err)) return new ApiError(503, 'buff_unavailable', 'Buff Token is not available right now.');
  return err instanceof ApiError ? err : new ApiError(500, 'buff_internal', 'Buff order could not be completed.');
}

function docsBody(): JsonRecord {
  const base = apiBaseUrl();
  return {
    ok: true,
    name: 'SafwanTiger Shop Reseller API',
    auth: 'Send your key as Authorization: Bearer YOUR_KEY or x-api-key: YOUR_KEY.',
    endpoints: {
      products: `GET ${base}/products`,
      balance: `GET ${base}/balance`,
      order: `POST ${base}/order`,
      legacy_products: `GET ${base}?action=products`,
      legacy_balance: `GET ${base}?action=balance`,
      legacy_order: `POST ${base}?action=order`,
      buff_check: `POST ${base}/buff/check`,
      buff_order: `POST ${base}/buff/order`,
      buff_status: `GET ${base}/buff/status?id=BUFF_ORDER_ID`,
    },
    product_fields: ['id', 'name', 'price', 'stock', 'available', 'unlimited_stock', 'warranty', 'description', 'note'],
    order_fields: [
      'order_id',
      'order_db_id',
      'product_id',
      'product_name',
      'quantity',
      'unit_price',
      'discount',
      'total',
      'balance_after',
      'items',
      'warranty',
      'note',
    ],
    buff_body: {
      orders_text: 'INVITE_CODE 20\nINVITE_CODE2 15',
      max_price: 'optional: reject the order if the price is higher than this (USDT)',
    },
    buff_notes:
      'Buff Token Muse AI: one INVITE_CODE QUANTITY pair per line, quantity 1-30 (billion tokens), max 10 lines. ' +
      'buff/check only prices the order. buff/order charges your balance; failed orders are refunded automatically. ' +
      'Status: processing, done, refunded, partial_refund, needs_check, failed.',
    order_body: {
      product_id: 123,
      quantity: 1,
      request_id: 'optional-unique-id',
      external_order_id: 'optional-unique-id-alias',
    },
  };
}

function isApiPath(url: URL): boolean {
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return true;
  return url.pathname === '/' && Boolean(url.searchParams.get('action'));
}

function actionFrom(url: URL): string {
  if (url.pathname.startsWith('/api/')) return url.pathname.slice('/api/'.length).replace(/\/+$/, '');
  return url.searchParams.get('action')?.trim().toLowerCase() ?? '';
}

export async function handleResellerApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  api: Api,
): Promise<boolean> {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (!isApiPath(url)) return false;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return true;
  }

  try {
    const action = actionFrom(url);
    if ((url.pathname === '/api' || url.pathname === '/') && !action) {
      sendJson(res, 200, docsBody());
      return true;
    }

    const keyValue = readApiKey(req, url);
    if (!keyValue) throw new ApiError(401, 'missing_api_key', 'API key is required.');
    const auth = await authenticateApiKey(keyValue);

    if (req.method === 'GET' && action === 'products') {
      const limit = Number(url.searchParams.get('limit') ?? undefined);
      const offset = Number(url.searchParams.get('offset') ?? undefined);
      const data = await listApiProducts({
        userId: auth.user.telegram_id,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      sendJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === 'GET' && action === 'balance') {
      const status = await getApiStatus(auth.user.telegram_id);
      sendJson(res, 200, {
        ok: true,
        balance: status.balance,
        currency: 'USDT',
        orders: status.orders,
        total_spent: status.totalSpent,
        recent_spent: status.recentSpent,
      });
      return true;
    }

    if (req.method === 'POST' && action === 'order') {
      const body = await readJsonBody(req);
      const productId = Number(body.product_id ?? body.productId ?? body.id);
      const qty = Number(body.quantity ?? body.qty ?? 1);
      const requestId = typeof body.request_id === 'string'
        ? body.request_id
        : typeof body.requestId === 'string'
          ? body.requestId
          : typeof body.external_order_id === 'string'
            ? body.external_order_id
            : typeof body.externalOrderId === 'string'
              ? body.externalOrderId
              : null;
      const order = await placeApiOrder({
        api,
        apiKeyId: auth.key.id,
        user: auth.user,
        productId,
        qty,
        requestId,
      });
      sendJson(res, 200, { ok: true, order });
      return true;
    }

    if (req.method === 'POST' && (action === 'buff/check' || action === 'buff_check')) {
      const body = await readJsonBody(req);
      if (!getBuffEnabled()) throw new ApiError(503, 'buff_disabled', 'Buff Token is not available right now.');
      try {
        const q = await quoteBuff(typeof body.orders_text === 'string' ? body.orders_text : '');
        sendJson(res, 200, {
          ok: true,
          orders_text: q.ordersText,
          lines: q.lines.map((l) => ({ invite_code: l.code, quantity_b: l.qty })),
          total_quantity_b: q.totalQty,
          price: q.priceUsdt,
          currency: 'USDT',
          available: q.fundable,
        });
      } catch (err) {
        throw buffApiError(err);
      }
      return true;
    }

    if (req.method === 'POST' && (action === 'buff/order' || action === 'buff_order')) {
      const body = await readJsonBody(req);
      const maxPrice = Number(body.max_price);
      try {
        const r = await placeBuffOrder({
          api,
          userId: auth.user.telegram_id,
          ordersText: typeof body.orders_text === 'string' ? body.orders_text : '',
          channel: 'api',
          chargeUser: true,
          maxPriceUsdt: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : undefined,
        });
        sendJson(res, 200, {
          ok: true,
          buff_order: {
            id: r.order.id,
            status: r.status === 'placed' ? 'processing' : 'needs_check',
            total_quantity_b: r.order.total_qty,
            price: r.priceUsdt,
            currency: 'USDT',
            balance_after: r.balanceAfter,
          },
        });
      } catch (err) {
        throw buffApiError(err);
      }
      return true;
    }

    if (req.method === 'GET' && (action === 'buff/status' || action === 'buff_status')) {
      const id = Number(url.searchParams.get('id') ?? url.searchParams.get('buff_order_id'));
      const order = Number.isInteger(id) && id > 0 ? await getBuffOrder(id).catch(() => null) : null;
      if (!order || order.user_id !== auth.user.telegram_id) {
        throw new ApiError(404, 'buff_order_not_found', 'Buff order not found.');
      }
      sendJson(res, 200, {
        ok: true,
        buff_order: {
          id: order.id,
          status: ['pending', 'placed'].includes(order.status) ? 'processing' : order.status,
          orders_text: order.orders_text,
          total_quantity_b: order.total_qty,
          price: Number(order.price_usdt),
          refunded: Number(order.refunded_usdt ?? 0),
          currency: 'USDT',
          created_at: order.created_at,
        },
      });
      return true;
    }

    throw new ApiError(404, 'unknown_endpoint', 'Unknown API endpoint.');
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
      return true;
    }
    sendJson(res, 500, {
      ok: false,
      error: 'internal_error',
      message: err instanceof Error ? err.message : 'Internal API error.',
    });
    return true;
  }
}

export function handleHealthRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (url.pathname !== '/healthz') return false;
  sendText(res, 200, 'ok');
  return true;
}
