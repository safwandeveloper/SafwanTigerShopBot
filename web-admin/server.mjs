import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT ?? process.env.WEB_ADMIN_PORT ?? 8787);
const username = process.env.WEB_ADMIN_USERNAME ?? '';
const password = process.env.WEB_ADMIN_PASSWORD ?? '';
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const sessions = new Map();

const tables = {
  users: { label: 'Users', icon: '♙', idField: 'telegram_id', order: 'last_seen_at.desc', fields: [
    ['telegram_id', 'Telegram ID', 'number', true], ['username', 'Username', 'text'], ['first_name', 'First name', 'text'],
    ['last_name', 'Last name', 'text'], ['language', 'Language', 'select', false, ['en', 'ar', 'vi']],
    ['balance', 'Balance', 'number'], ['stock_alert', 'Stock alerts', 'checkbox'], ['announcements', 'Announcements', 'checkbox'],
    ['ref_code', 'Referral code', 'text'], ['referred_by', 'Referred by', 'number'], ['joined_at', 'Joined at', 'datetime-local'],
    ['last_seen_at', 'Last seen at', 'datetime-local'],
  ] },
  admins: { label: 'Admins', icon: '♛', idField: 'telegram_id', fields: [['telegram_id', 'Telegram ID', 'number', true], ['username', 'Username', 'text']] },
  categories: { label: 'Categories', icon: '◈', idField: 'id', fields: [
    ['id', 'ID', 'number', true], ['name', 'Name', 'text'], ['emoji', 'Emoji', 'text'], ['sort_order', 'Sort order', 'number'], ['active', 'Active', 'checkbox'],
  ] },
  products: { label: 'Products', icon: '⌘', idField: 'id', order: 'created_at.desc', fields: [
    ['id', 'ID', 'number', true], ['category_id', 'Category ID', 'number'], ['name', 'Name', 'text'], ['description', 'Description', 'textarea'],
    ['note', 'Note', 'textarea'], ['price', 'Price', 'number'], ['stock', 'Stock', 'number'], ['warranty', 'Warranty', 'text'],
    ['emoji', 'Emoji', 'text'], ['emoji_id', 'Premium emoji ID', 'text'], ['active', 'Active', 'checkbox'],
  ] },
  orders: { label: 'Orders', icon: '▣', idField: 'id', order: 'created_at.desc', fields: [
    ['id', 'ID', 'number', true], ['user_id', 'User ID', 'number', true], ['product_id', 'Product ID', 'number'], ['product_name', 'Product', 'text', true],
    ['qty', 'Quantity', 'number'], ['unit_price', 'Unit price', 'number'], ['total', 'Total', 'number'], ['delivery', 'Delivery', 'textarea'],
    ['status', 'Status', 'select', false, ['paid', 'refunded', 'cancelled']], ['created_at', 'Created at', 'datetime-local', true],
  ] },
  deposits: { label: 'Deposits', icon: '◉', idField: 'id', order: 'created_at.desc', fields: [
    ['id', 'ID', 'number', true], ['user_id', 'User ID', 'number', true], ['method', 'Method', 'text', true], ['amount', 'Amount', 'number'],
    ['status', 'Status', 'select', false, ['pending', 'approved', 'rejected']], ['reference', 'Reference / TX hash', 'text'], ['note', 'Note', 'textarea'],
    ['created_at', 'Created at', 'datetime-local', true], ['updated_at', 'Updated at', 'datetime-local', true],
  ] },
  payment_methods: { label: 'Payment methods', icon: '₿', idField: 'id', fields: [
    ['id', 'ID', 'number', true], ['name', 'Name', 'text'], ['instructions', 'Instructions', 'textarea'], ['min_amount', 'Minimum amount', 'number'],
    ['active', 'Active', 'checkbox'], ['sort_order', 'Sort order', 'number'],
  ] },
  settings: { label: 'Settings', icon: '⚙', idField: 'key', fields: [
    ['key', 'Key', 'text', true], ['value', 'JSON value', 'textarea'], ['updated_by', 'Updated by', 'number'], ['updated_at', 'Updated at', 'datetime-local', true],
  ] },
  announcements: { label: 'Announcements', icon: '📣', idField: 'id', fields: [
    ['id', 'ID', 'number', true], ['body', 'Body', 'textarea'], ['sent_at', 'Sent at', 'datetime-local'], ['created_by', 'Created by', 'number'], ['created_at', 'Created at', 'datetime-local', true],
  ] },
  referrals: { label: 'Referrals', icon: '↗', idField: 'id', order: 'created_at.desc', fields: [
    ['id', 'ID', 'number', true], ['referrer_id', 'Referrer ID', 'number', true], ['referee_id', 'Referee ID', 'number', true], ['created_at', 'Created at', 'datetime-local', true],
  ] },
  gift_codes: { label: 'Gift codes', icon: '🎁', idField: 'code', fields: [
    ['code', 'Code', 'text', true], ['amount', 'Amount', 'number'], ['max_uses', 'Max uses', 'number'], ['uses', 'Uses', 'number', true],
    ['active', 'Active', 'checkbox'], ['expires_at', 'Expires at', 'datetime-local'], ['created_at', 'Created at', 'datetime-local', true],
  ] },
  promos: { label: 'Promos', icon: '%', idField: 'id', fields: [
    ['id', 'ID', 'number', true], ['code', 'Code', 'text'], ['name', 'Name', 'text'], ['active', 'Active', 'checkbox'],
    ['starts_at', 'Starts at', 'datetime-local'], ['ends_at', 'Ends at', 'datetime-local'], ['created_at', 'Created at', 'datetime-local', true],
  ] },
  supplier_api_sources: { label: 'Supplier APIs', icon: '⚡', idField: 'id', fields: [
    ['id', 'ID', 'number', true], ['name', 'Name', 'text'], ['provider', 'Provider', 'text'], ['base_url', 'Base URL', 'text'], ['active', 'Active', 'checkbox'], ['created_at', 'Created at', 'datetime-local', true],
  ] },
  supplier_product_links: { label: 'Supplier links', icon: '⇄', idField: 'id', fields: [
    ['id', 'ID', 'number', true], ['product_id', 'Product ID', 'number'], ['supplier_source_id', 'Supplier source ID', 'number'], ['supplier_product_id', 'Supplier product ID', 'text'], ['active', 'Active', 'checkbox'],
  ] },
  user_price_overrides: { label: 'Price overrides', icon: '$', idField: 'id', fields: [
    ['id', 'ID', 'number', true], ['user_id', 'User ID', 'number'], ['product_id', 'Product ID', 'number'], ['price', 'Price', 'number'], ['created_at', 'Created at', 'datetime-local', true],
  ] },
  wallet_ledger: { label: 'Wallet ledger', icon: '↕', idField: 'id', order: 'created_at.desc', fields: [] },
  product_items: { label: 'Product items', icon: '▤', idField: 'id', fields: [] },
  order_delivery_submissions: { label: 'Delivery submissions', icon: '⌁', idField: 'id', fields: [] },
  reseller_api_orders: { label: 'Reseller API orders', icon: '⇥', idField: 'id', order: 'created_at.desc', fields: [] },
  supplier_order_logs: { label: 'Supplier order logs', icon: '≋', idField: 'id', order: 'created_at.desc', fields: [] },
  promo_tiers: { label: 'Promo tiers', icon: '⊞', idField: 'id', fields: [] },
  referral_redemptions: { label: 'Referral redemptions', icon: '↪', idField: 'id', order: 'created_at.desc', fields: [] },
  referral_milestones: { label: 'Referral milestones', icon: '★', idField: 'id', order: 'created_at.desc', fields: [] },
};
const writableTables = new Set(['categories', 'products', 'payment_methods', 'gift_codes', 'promos', 'supplier_api_sources', 'supplier_product_links', 'user_price_overrides']);

if (!username || !password || !supabaseUrl || !serviceRoleKey) throw new Error('WEB_ADMIN_USERNAME, WEB_ADMIN_PASSWORD, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const cookieValue = (req, name) => (req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')).find(([key]) => key === name)?.[1];
const authorized = (req) => {
  const token = cookieValue(req, 'web_admin_session');
  return Boolean(token && sessions.has(token));
};
const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};
const safeEqual = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const supabase = async (table, query = '', options = {}) => {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}${query}`, {
    method: options.method ?? (options.head ? 'HEAD' : 'GET'),
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Prefer: options.head ? 'count=exact' : 'return=representation', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.range ? { Range: options.range } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase ${table} request failed: ${response.status}`);
  if (options.head) return Number((response.headers.get('content-range') ?? '*/0').split('/')[1] ?? 0);
  return text ? JSON.parse(text) : null;
};
const cleanPayload = (config, payload, isInsert) => {
  const allowed = new Set(config.fields.map((field) => field[0]));
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => allowed.has(key) && (isInsert || key !== config.idField) && value !== ''));
};
const serializedTables = Object.fromEntries(Object.entries(tables).map(([key, config]) => [key, { ...config, writable: writableTables.has(key) }]));
const dashboardData = async () => {
  const [userCount, orderCount, productCount, pendingDeposits, users, orders, products, deposits] = await Promise.all([
    supabase('users', '', { head: true }), supabase('orders', '', { head: true }), supabase('products', '', { head: true }), supabase('deposits?status=eq.pending', '', { head: true }),
    supabase('users?select=telegram_id,username,first_name,balance,last_seen_at&order=last_seen_at.desc&limit=8'),
    supabase('orders?select=id,user_id,product_name,qty,total,status,created_at&order=created_at.desc&limit=8'),
    supabase('products?select=id,name,emoji,price,stock,active&order=created_at.desc&limit=8'),
    supabase('deposits?select=id,user_id,method,amount,status,created_at&order=created_at.desc&limit=8'),
  ]);
  return { metrics: { userCount, orderCount, productCount, pendingDeposits }, users, orders, products, deposits, generatedAt: new Date().toISOString() };
};
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const serveStatic = async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = join(publicDir, requested);
  if (!file.startsWith(publicDir)) return json(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'POST' && pathname === '/api/login') {
      const form = new URLSearchParams(await readBody(req));
      if (!safeEqual(form.get('username') ?? '', username) || !safeEqual(form.get('password') ?? '', password)) return json(res, 401, { error: 'Invalid credentials' });
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now());
      res.writeHead(204, { 'Set-Cookie': `web_admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      return res.end();
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = cookieValue(req, 'web_admin_session');
      if (token) sessions.delete(token);
      res.writeHead(204, { 'Set-Cookie': 'web_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      return res.end();
    }
    if (pathname === '/api/session') return authorized(req) ? json(res, 200, { authenticated: true }) : json(res, 401, { authenticated: false });
    if (!authorized(req) && pathname.startsWith('/api/')) return json(res, 401, { error: 'Unauthorized' });
    if (pathname === '/api/admin-config') return json(res, 200, { tables: serializedTables });
    if (pathname === '/api/dashboard') return json(res, 200, await dashboardData());

    const match = pathname.match(/^\/api\/tables\/([a-z_]+)(?:\/([^/]+))?$/);
    if (match) {
      const [, table, id] = match;
      const config = tables[table];
      if (!config) return json(res, 404, { error: 'Unknown table' });
      if (req.method === 'GET' && !id) {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
        const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);
        const rows = await supabase(table, `?select=*&order=${encodeURIComponent(config.order ?? `${config.idField}.desc`)}&limit=${limit}`, { range: `${offset}-${offset + limit - 1}` });
        return json(res, 200, { rows, count: await supabase(table, '', { head: true }), limit, offset });
      }
      const filter = `${config.idField}=eq.${encodeURIComponent(decodeURIComponent(id ?? ''))}`;
      if ((req.method === 'POST' || req.method === 'PATCH') && !writableTables.has(table)) return json(res, 403, { error: 'This data area is view-only for safety' });
      if (req.method === 'DELETE') return json(res, 405, { error: 'Delete is disabled in the web dashboard' });
      if (req.method === 'POST' && !id) return json(res, 201, await supabase(table, '', { method: 'POST', body: cleanPayload(config, JSON.parse(await readBody(req)), true) }));
      if (req.method === 'PATCH' && id) return json(res, 200, await supabase(table, `?${filter}`, { method: 'PATCH', body: cleanPayload(config, JSON.parse(await readBody(req)), false) }));
    }
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error instanceof Error ? error.message : 'Dashboard request failed' });
  }
}).listen(port, () => console.log(`SafwanTiger Web Admin listening on http://localhost:${port}`));
