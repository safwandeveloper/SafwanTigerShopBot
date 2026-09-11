import type http from 'node:http';
import type { Api } from 'grammy';
import { findDepositByTxHash } from '../db/queries.js';
import { logger } from '../logger.js';
import { processZiniPayPaidInvoice } from './zinipayDeposit.js';
import { verifyZiniPayInvoice } from './zinipay.js';

export async function handleZiniPayWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  api: Api,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/zinipay/webhook') return false;
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return true;
  }

  let body = '';
  for await (const chunk of req) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (body.length > 256 * 1024) {
      res.writeHead(413);
      res.end();
      return true;
    }
  }
  let payload: { invoice_id?: string | number; status?: string };
  try {
    payload = body ? (JSON.parse(body) as typeof payload) : {};
  } catch {
    payload = {};
  }
  const invoiceId = String(payload.invoice_id ?? url.searchParams.get('invoice_id') ?? '');
  if (!invoiceId) {
    res.writeHead(400);
    res.end();
    return true;
  }

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true }));

  void (async () => {
    const verified = await verifyZiniPayInvoice(invoiceId);
    if (!verified.ok || verified.invoice.status !== 'COMPLETED') return;
    const deposit = await findDepositByTxHash(`zinipay:${invoiceId}`);
    if (deposit) await processZiniPayPaidInvoice(api, deposit.id, verified.invoice);
  })().catch((err) => logger.warn({ err, invoiceId }, 'ZiniPay webhook processing failed'));
  return true;
}
