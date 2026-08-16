import {
  listPaymentMethodNamesByProvider,
  listPendingDepositExpectedAmounts,
} from '../db/queries.js';
import type { PaymentProvider } from '../types.js';

export const USDT_QUOTE_TTL_MS = 30 * 60 * 1000;
const MAX_RESERVATION_ATTEMPTS = 30;
const COLLISION_TOLERANCE = 0.00000001;

export function validateUsdtQuoteAmount(args: {
  expectedAmount: number | null | undefined;
  actualAmount: number;
  quoteExpiresAt?: string | null;
  nowMs?: number;
}): { ok: true; amount: number } | { ok: false; reason: string } {
  if (args.expectedAmount === null || args.expectedAmount === undefined) {
    return {
      ok: false,
      reason: 'USDT deposit has no locked quote — admin should approve manually',
    };
  }
  if (args.quoteExpiresAt) {
    const exp = new Date(args.quoteExpiresAt).getTime();
    if (Number.isFinite(exp) && (args.nowMs ?? Date.now()) > exp) {
      return {
        ok: false,
        reason: 'USDT quote expired — admin should approve manually',
      };
    }
  }
  const expectedAmount = Number(args.expectedAmount);
  const actualAmount = Number(args.actualAmount);
  if (
    !Number.isFinite(expectedAmount) ||
    !Number.isFinite(actualAmount) ||
    Math.round(Math.abs(actualAmount - expectedAmount) * 10000) >= 1
  ) {
    return {
      ok: false,
      reason: `on-chain amount ${actualAmount.toFixed(4)} does not match expected ${expectedAmount.toFixed(4)}`,
    };
  }
  return { ok: true, amount: expectedAmount };
}

export function roundUsdtBase(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function ceilUsdtBase(amount: number): number {
  return Math.ceil((amount - Number.EPSILON) * 100) / 100;
}

export function uniqueUsdtAmount(baseAmount: number, uniquifier: number): number {
  if (!Number.isInteger(uniquifier) || uniquifier < 1 || uniquifier > 99) {
    throw new Error('USDT uniquifier must be an integer from 1 to 99');
  }
  return Number((roundUsdtBase(baseAmount) + uniquifier * 0.0001).toFixed(4));
}

export function chooseUniqueUsdtAmount(
  baseAmount: number,
  occupied: number[],
  randomUniquifier: () => number,
  maxAttempts = MAX_RESERVATION_ATTEMPTS,
): number | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = uniqueUsdtAmount(baseAmount, randomUniquifier());
    if (!occupied.some((amount) => Math.abs(amount - candidate) < COLLISION_TOLERANCE)) {
      return candidate;
    }
  }
  return null;
}

export async function reserveUniqueUsdtAmount(args: {
  baseAmount: number;
  provider: Extract<PaymentProvider, 'usdt_trc20' | 'usdt_bep20' | 'usdt_ton'>;
  randomUniquifier?: () => number;
}): Promise<{ amount: number; expiresAt: Date } | null> {
  const methods = await listPaymentMethodNamesByProvider(args.provider);
  const now = new Date();
  const randomUniquifier =
    args.randomUniquifier ??
    (() => Math.floor(Math.random() * 99) + 1);

  for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
    const occupied = await listPendingDepositExpectedAmounts(methods, new Date().toISOString());
    const candidate = chooseUniqueUsdtAmount(
      args.baseAmount,
      occupied,
      randomUniquifier,
      1,
    );
    if (candidate !== null) {
      return {
        amount: candidate,
        expiresAt: new Date(now.getTime() + USDT_QUOTE_TTL_MS),
      };
    }
  }
  return null;
}
