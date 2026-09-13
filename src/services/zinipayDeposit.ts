import type { Api } from 'grammy';
import { formatPriceWithCurrency } from '../../config/currencies.js';
import { creditZiniPayDeposit, findDepositByTxHash, getUserByTelegramId } from '../db/queries.js';
import { logger } from '../logger.js';
import { renderMdHtml } from './premium.js';
import { fulfilOrderForDeposit } from './orderFulfill.js';
import { notifySalesBikashDeposit } from './publicFeed.js';
import { credit } from './wallet.js';
import type { ZiniPayInvoice } from './zinipay.js';

async function deleteInvoiceMessage(
  api: Api,
  chatId: number | null,
  messageId: number | null,
  depositId: number,
): Promise<void> {
  if (chatId == null || messageId == null) return;
  try {
    await api.deleteMessage(chatId, messageId);
  } catch (err) {
    logger.warn({ err, depositId, chatId, messageId }, 'ZiniPay invoice message delete failed');
  }
}

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

  await deleteInvoiceMessage(
    api,
    deposit.notify_chat_id,
    deposit.notify_message_id,
    deposit.id,
  );

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
      renderMdHtml(
        `{deposits_wallet} *Payment received*\n\n{paymethod_others} *bKash payment confirmed!*\n\n{gift_usdt} Credited: *${amount}*\n{prod_wallet} New balance: *${balance}*`,
      ),
      { parse_mode: 'HTML' },
    )
    .catch((err) => logger.warn({ err, userId: user.telegram_id }, 'ZiniPay success DM failed'));
  void notifySalesBikashDeposit(api, {
    userId: user.telegram_id,
    username: user.username,
    firstName: user.first_name,
    amount: result.amount,
    method: deposit.method,
    invoiceAmountBdt: Number(invoice.amount),
    invoiceId,
    transactionId: invoice.transaction_id,
  }).catch((err) => logger.warn({ err, depositId: deposit.id }, 'ZiniPay sales announcement failed'));
  return true;
}
