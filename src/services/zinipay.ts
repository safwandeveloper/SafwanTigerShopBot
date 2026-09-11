import { env } from '../env.js';
import { logger } from '../logger.js';

export type ZiniPayInvoice = {
  invoice_id: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | string;
  amount: number | string;
  payment_method?: string;
  transaction_id?: string;
};

type CreateResponse = {
  status?: boolean;
  message?: string;
  payment_url?: string;
  invoice_id?: string | number;
};

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  if (!env.ZINIPAY_API_KEY) return { ok: false, reason: 'ZiniPay API key is not configured' };
  try {
    const response = await fetch(`${env.ZINIPAY_API_BASE_URL.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'zini-api-key': env.ZINIPAY_API_KEY,
        ...(init.headers ?? {}),
      },
    });
    const body = (await response.json()) as T & { message?: string };
    if (!response.ok) {
      logger.warn(
        { status: response.status, body },
        'ZiniPay API rejected request',
      );
      return { ok: false, reason: body.message ?? `ZiniPay HTTP ${response.status}` };
    }
    return { ok: true, data: body };
  } catch (err) {
    logger.warn({ err }, 'ZiniPay API request failed');
    return { ok: false, reason: err instanceof Error ? err.message : 'ZiniPay request failed' };
  }
}

export async function createZiniPayInvoice(args: {
  amount: number;
  customerName?: string;
  customerEmail: string;
  validationId: string;
  metadata: Record<string, string>;
  webhookUrl: string;
}): Promise<
  | { ok: true; invoice: { invoice_id: string; payment_url: string } }
  | { ok: false; reason: string }
> {
  if (!env.ZINIPAY_REDIRECT_URL) {
    return { ok: false, reason: 'ZiniPay redirect URL is not configured' };
  }
  const result = await request<CreateResponse>('/v1/payment/create', {
    method: 'POST',
    body: JSON.stringify({
      cus_name: args.customerName || 'Telegram Customer',
      cus_email: args.customerEmail,
      amount: args.amount,
      metadata: args.metadata,
      redirect_url: env.ZINIPAY_REDIRECT_URL,
      cancel_url: env.ZINIPAY_CANCEL_URL || env.ZINIPAY_REDIRECT_URL,
      val_id: args.validationId,
      webhook_url: args.webhookUrl,
    }),
  });
  if (!result.ok) return result;
  const invoiceId =
    result.data.invoice_id == null
      ? result.data.payment_url?.split('/').filter(Boolean).pop() ?? ''
      : String(result.data.invoice_id);
  if (!result.data.status || !invoiceId || !result.data.payment_url) {
    logger.warn(
      {
        amount: args.amount,
        validationId: args.validationId,
        response: result.data,
      },
      'ZiniPay invoice response was incomplete',
    );
    return { ok: false, reason: result.data.message ?? 'ZiniPay invoice response was incomplete' };
  }
  return {
    ok: true,
    invoice: { invoice_id: invoiceId, payment_url: result.data.payment_url },
  };
}

export async function verifyZiniPayInvoice(
  invoiceId: string,
): Promise<{ ok: true; invoice: ZiniPayInvoice } | { ok: false; reason: string }> {
  const result = await request<ZiniPayInvoice>('/v1/payment/verify', {
    method: 'POST',
    body: JSON.stringify({ invoice_id: invoiceId }),
  });
  return result.ok
    ? { ok: true, invoice: result.data }
    : result;
}
