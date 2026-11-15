import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Api } from 'grammy';
import { logger } from '../logger.js';
import {
  MAX_ATTEMPTS,
  checkChallengeAnswer,
  completeHumanVerification,
  createChallenge,
  getVerification,
  hashDevice,
  hashIp,
  maskIp,
  parseLinkToken,
  recordWrongAnswer,
  type VerifyStatus,
} from './humanVerify.js';
import { getHumanVerifyEnabled } from './settings.js';

type Json = Record<string, unknown>;

const ASSET_DIR = path.resolve(process.cwd(), 'assets', 'verify');
const BODY_LIMIT = 8 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;

let pageCache: string | null = null;
let logoCache: Buffer | null = null;
let botUsername = '';

function page(): string {
  if (!pageCache) pageCache = fs.readFileSync(path.join(ASSET_DIR, 'page.html'), 'utf8');
  return pageCache;
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function sendJson(res: http.ServerResponse, status: number, body: Json): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  const real = req.headers['x-real-ip'];
  return first || (Array.isArray(real) ? real[0] : real) || req.socket.remoteAddress || '';
}

const hits = new Map<string, { n: number; at: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > RATE_WINDOW_MS) {
    hits.set(ip, { n: 1, at: now });
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now - v.at > RATE_WINDOW_MS) hits.delete(k);
    }
    return false;
  }
  h.n++;
  return h.n > RATE_MAX;
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > BODY_LIMIT) throw new Error('body_too_large');
    chunks.push(buf);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function pageState(status: VerifyStatus | null, expired: boolean): string {
  switch (status) {
    case 'pending':
      return expired ? 'expired' : 'challenge';
    case 'verified':
    case 'device_dup':
      return 'done';
    case 'ip_limited':
      return 'ip';
    case 'failed':
      return 'failed';
    default:
      return 'expired';
  }
}

async function renderPage(req: http.IncomingMessage, res: http.ServerResponse, url: URL, api: Api) {
  const token = url.searchParams.get('t') ?? '';
  const link = parseLinkToken(token);
  const row = link ? await getVerification(link.userId) : null;
  const state = getHumanVerifyEnabled() && link ? pageState(row?.status ?? null, link.expired) : 'expired';
  if (!botUsername) {
    try {
      botUsername = (await api.getMe()).username;
    } catch {
      botUsername = 'SafwanTigerShopBot';
    }
  }
  const secs = link ? Math.max(0, link.exp - Math.floor(Date.now() / 1000)) : 0;
  const values: Record<string, string> = {
    __UID__: link ? String(link.userId) : '—',
    __IP__: escHtml(maskIp(clientIp(req))),
    __TOKEN__: link ? token : '',
    __STATE__: state,
    __EXP__: String(secs),
    __TRIES__: String(Math.max(0, MAX_ATTEMPTS - (row?.attempts ?? 0))),
    __BOT__: escHtml(botUsername),
  };
  const html = page().replace(/__(UID|IP|TOKEN|STATE|EXP|TRIES|BOT)__/g, (m) => values[m] ?? '');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(html);
}

async function pendingFromBody(body: Json): Promise<{ userId: number } | { state: string }> {
  const link = parseLinkToken(typeof body.t === 'string' ? body.t : '');
  if (!link || !getHumanVerifyEnabled()) return { state: 'expired' };
  const row = await getVerification(link.userId);
  const state = pageState(row?.status ?? null, link.expired);
  if (state !== 'challenge') return { state };
  return { userId: link.userId };
}

async function handleChallenge(res: http.ServerResponse, body: Json): Promise<void> {
  const p = await pendingFromBody(body);
  if ('state' in p) return sendJson(res, 200, { ok: false, state: p.state });
  const { challenge, token } = createChallenge(p.userId);
  sendJson(res, 200, { ok: true, challenge, c: token });
}

async function handleSubmit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Json,
  api: Api,
): Promise<void> {
  const p = await pendingFromBody(body);
  if ('state' in p) return sendJson(res, 200, { ok: false, state: p.state });
  const elapsed = Number(body.elapsed);
  const moves = Number(body.moves);
  if (body.human !== true || !Number.isFinite(elapsed) || elapsed < 1500 || !(moves >= 1)) {
    return sendJson(res, 200, {
      ok: false,
      state: 'error',
      message: "Please tick \"I'm not a robot\" and try again.",
    });
  }
  if (!checkChallengeAnswer(p.userId, body.c, body.answer)) {
    const r = await recordWrongAnswer(api, p.userId);
    if (r.status !== 'pending') return sendJson(res, 200, { ok: false, state: 'failed' });
    const { challenge, token } = createChallenge(p.userId);
    return sendJson(res, 200, {
      ok: false,
      state: 'wrong',
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - r.attempts),
      challenge,
      c: token,
    });
  }
  const ip = clientIp(req);
  const status = await completeHumanVerification(
    api,
    p.userId,
    ip ? hashIp(ip) : null,
    hashDevice(body.dev),
  );
  if (status === 'verified') return sendJson(res, 200, { ok: true, state: 'success' });
  if (status === 'device_dup') {
    return sendJson(res, 200, {
      ok: true,
      state: 'done',
      note: 'This device was already used to verify another account, so no reward was added.',
    });
  }
  if (status === 'ip_limited') return sendJson(res, 200, { ok: false, state: 'ip' });
  sendJson(res, 200, { ok: false, state: pageState(status, false) });
}

export async function handleHumanVerifyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  api: Api,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/verify' && !url.pathname.startsWith('/verify/')) return false;
  try {
    if (req.method === 'GET' && (url.pathname === '/verify' || url.pathname === '/verify/')) {
      await renderPage(req, res, url, api);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/verify/logo.jpg') {
      if (!logoCache) logoCache = fs.readFileSync(path.join(ASSET_DIR, 'logo.jpg'));
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      res.end(logoCache);
      return true;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/verify/api/')) {
      if (rateLimited(clientIp(req))) {
        sendJson(res, 429, { ok: false, state: 'error', message: 'Too many requests. Wait a minute.' });
        return true;
      }
      const body = await readJson(req);
      if (url.pathname === '/verify/api/challenge') await handleChallenge(res, body);
      else if (url.pathname === '/verify/api/submit') await handleSubmit(req, res, body, api);
      else sendJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    sendJson(res, 404, { ok: false, error: 'not_found' });
    return true;
  } catch (err) {
    logger.error({ err, path: url.pathname }, 'human verify request failed');
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, state: 'error', message: 'Something went wrong. Please try again.' });
    }
    return true;
  }
}
