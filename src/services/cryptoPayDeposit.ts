import type { Api } from 'grammy';
import { formatPriceWithCurrency } from '../../config/currencies.js';
import { getUserByTelegramId, creditCryptoPayDeposit } from '../db/queries.js';
import { logger } from '../logger.js';
import { t } from '../i18n/index.js';
import { renderMdHtml } from './premium.js';
import * as adminLog from './adminLog.js';
import type { CryptoPayInvoice } from './cryptoPay.js';
import { findDepositByTxHash } from '../db/queries.js';

export async function processCryptoPayPaidInvoice(
  api: Api,
  depositId: number,
  invoice: CryptoPayInvoice,
): Promise<boolean> {
  if (invoice.status !== 'paid') return false;
  const invoiceId = String(invoice.invoice_id);
  const txHash = `cryptopay:${invoiceId}`;
  const deposit = await findDepositByTxHash(txHash);
  if (!deposit || deposit.id !== depositId) {
    logger.warn({ depositId, invoiceId }, 'Crypto Pay deposit not found for paid invoice');
    return false;
  }
  if (invoice.payload !== undefined && invoice.payload !== String(depositId)) {
    logger.warn({ depositId, invoiceId }, 'Crypto Pay invoice payload mismatch');
    return false;
  }
  if (Math.abs(Number(invoice.amount) - Number(deposit.amount)) > 0.000001) {
    logger.warn(
      { depositId, invoiceId, expected: deposit.amount, actual: invoice.amount },
      'Crypto Pay invoice amount mismatch',
    );
    return false;
  }

  const result = await creditCryptoPayDeposit(deposit.id, txHash);
  if (!result.credited || result.user_id == null || result.amount == null) return false;

  const user = await getUserByTelegramId(result.user_id);
  if (!user) return false;
  const amount = formatPriceWithCurrency(result.amount, user.currency);
  const balance = formatPriceWithCurrency(result.new_balance ?? 0, user.currency);
  const message = t(user.language, 'topup.cryptobot.success', { amount, balance });
  void api
    .sendMessage(user.telegram_id, renderMdHtml(message), { parse_mode: 'HTML' })
    .catch((err) => logger.warn({ err, userId: user.telegram_id }, 'Crypto Pay success DM failed'));

  void adminLog
    .logTopupResolved(api, {
      user: {
        telegram_id: user.telegram_id,
        username: user.username,
        first_name: user.first_name,
        email: user.email,
      },
      depositDbId: deposit.id,
      method: deposit.method,
      amount: result.amount,
      status: 'approved',
      balanceAfter: result.new_balance,
      resolvedBy: 0,
      reference: txHash,
    })
    .catch((err) => logger.warn({ err, depositId: deposit.id }, 'Crypto Pay admin log failed'));
  return true;
}
