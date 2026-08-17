import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

if (!username || !password || !supabaseUrl || !serviceRoleKey) {
  throw new Error('WEB_ADMIN_USERNAME, WEB_ADMIN_PASSWORD, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const cookieValue = (req, name) =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];

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
    method: options.head ? 'HEAD' : 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: options.head ? 'count=exact' : 'return=representation',
    },
  });
  if (!response.ok) throw new Error(`Supabase ${table} request failed: ${response.status}`);
  if (options.head) {
    const range = response.headers.get('content-range') ?? '*/0';
    return Number(range.split('/')[1] ?? 0);
  }
  return response.json();
};

const dashboardData = async () => {
  const [userCount, orderCount, productCount, pendingDeposits, users, orders, products, deposits] =
    await Promise.all([
      supabase('users', '', { head: true }),
      supabase('orders', '', { head: true }),
      supabase('products', '', { head: true }),
      supabase('deposits?status=eq.pending', '', { head: true }),
      supabase('users?select=telegram_id,username,first_name,balance,last_seen_at&order=last_seen_at.desc&limit=8'),
      supabase('orders?select=id,user_id,product_name,qty,total,status,created_at&order=created_at.desc&limit=8'),
      supabase('products?select=id,name,emoji,price,stock,active&order=created_at.desc&limit=8'),
      supabase('deposits?select=id,user_id,method,amount,status,created_at&order=created_at.desc&limit=8'),
    ]);

  return {
    metrics: { userCount, orderCount, productCount, pendingDeposits },
    users,
    orders,
    products,
    deposits,
    generatedAt: new Date().toISOString(),
  };
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const serveStatic = async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = join(publicDir, requested);
  if (!file.startsWith(publicDir)) return json(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
};

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && pathname === '/api/login') {
      const form = new URLSearchParams(await readBody(req));
      if (!safeEqual(form.get('username') ?? '', username) || !safeEqual(form.get('password') ?? '', password)) {
        return json(res, 401, { error: 'Invalid credentials' });
      }
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now());
      res.writeHead(204, {
        'Set-Cookie': `web_admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      });
      return res.end();
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = cookieValue(req, 'web_admin_session');
      if (token) sessions.delete(token);
      res.writeHead(204, { 'Set-Cookie': 'web_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      return res.end();
    }
    if (pathname === '/api/session') return authorized(req) ? json(res, 200, { authenticated: true }) : json(res, 401, { authenticated: false });
    if (pathname === '/api/dashboard') {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, await dashboardData());
    }
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Dashboard request failed' });
  }
}).listen(port, () => {
  console.log(`SafwanTiger Web Admin listening on http://localhost:${port}`);
});
