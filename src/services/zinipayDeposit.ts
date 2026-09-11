import type { Api } from 'grammy';
import { formatPriceWithCurrency } from '../../config/currencies.js';
import { creditZiniPayDeposit, findDepositByTxHash, getUserByTelegramId } from '../db/queries.js';
import { logger } from '../logger.js';
import { t } from '../i18n/index.js';
import { renderMdHtml } from './premium.js';
import { fulfilOrderForDeposit } from './orderFulfill.js';
import { credit } from './wallet.js';
import type { ZiniPayInvoice } from './zinipay.js';

export async function processZiniPayPaidInvoice(
  api: Api,
  depositId: number,
  invoice: ZiniPayInvoice,
): Promise<boolean> {
  if (invoice.status !== 'COMPLETED') return false;
  const invoiceId = String(invoice.invoice_id);
  const txHash = `zinipay:${invoiceId}`;
  const deposit = await findDepositByTxHash(txHash);
  if (!deposit || deposit.id !== depositId) return false;
  const expectedInvoiceAmount = Number(deposit.expected_amount ?? deposit.amount);
  if (Math.abs(Number(invoice.amount) - expectedInvoiceAmount) > 0.000001) {
    logger.warn({ depositId, invoiceId, expected: expectedInvoiceAmount, actual: invoice.amount }, 'ZiniPay invoice amount mismatch');
    return false;
  }

  const result = await creditZiniPayDeposit(deposit.id, txHash);
  if (!result.credited || result.user_id == null || result.amount == null) return false;

  if (deposit.order_intent) {
    try {
      await fulfilOrderForDeposit({
        api,
        deposit,
        intent: deposit.order_intent,
        provider: 'zinipay',
        methodName: deposit.method,
      });
    } catch (err) {
      logger.error({ err, depositId }, 'ZiniPay direct-pay fulfilment failed');
      await credit(
        deposit.user_id,
        Number(deposit.order_intent.total),
        `deposit:${deposit.id}:zinipay_fulfil_error`,
        'deposit_credit',
      );
    }
    return true;
  }

  const user = await getUserByTelegramId(result.user_id);
  if (!user) return false;
  const amount = formatPriceWithCurrency(result.amount, user.currency);
  const balance = formatPriceWithCurrency(result.new_balance ?? 0, user.currency);
  await api
    .sendMessage(
      user.telegram_id,
      renderMdHtml(`✅ *Payment received*\n\n${t(user.language, 'topup.cryptobot.success', { amount, balance })}`),
      { parse_mode: 'HTML' },
    )
    .catch((err) => logger.warn({ err, userId: user.telegram_id }, 'ZiniPay success DM failed'));
  return true;
}
