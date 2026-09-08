/**
 * Money primitives for HOWLOW.
 *
 * INVARIANT: money is always stored, transported and computed as an integer
 * number of MINOR units (cents). Floating point arithmetic is never used on
 * any monetary value. Values that cross the process boundary (JSON, SQL
 * BIGINT) are represented as `bigint` in TypeScript and as decimal strings on
 * the wire, because JSON has no integer type wide enough to be safe.
 */

/** ISO-4217 currency codes supported by HOWLOW. */
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'ETB'] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Number of minor units in one major unit, per currency. */
const MINOR_UNIT_EXPONENT: Record<Currency, number> = {
  USD: 2,
  EUR: 2,
  ETB: 2,
};

/** An amount of money as an integer count of minor units. */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function money(amountMinor: bigint, currency: Currency): Money {
  return { amountMinor, currency };
}

/**
 * Parse a decimal string of MINOR units (the shape used on the wire and by the
 * `pg` driver for BIGINT columns). Rejects anything that is not an integer.
 */
export function moneyFromMinorString(value: string, currency: Currency): Money {
  if (!/^-?\d+$/.test(value)) {
    throw new MoneyError(`Not an integer minor-unit amount: ${JSON.stringify(value)}`);
  }
  return { amountMinor: BigInt(value), currency };
}

/** Serialise minor units for JSON / SQL parameters. */
export function moneyToMinorString(value: Money): string {
  return value.amountMinor.toString();
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function negateMoney(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function isZeroMoney(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function isPositiveMoney(a: Money): boolean {
  return a.amountMinor > 0n;
}

export function isNegativeMoney(a: Money): boolean {
  return a.amountMinor < 0n;
}

/**
 * Format for display only. Never feed the result back into a calculation.
 * Performed with integer/string arithmetic so no float ever touches the value.
 */
export function formatMoney(value: Money): string {
  const exponent = MINOR_UNIT_EXPONENT[value.currency];
  const negative = value.amountMinor < 0n;
  const digits = (negative ? -value.amountMinor : value.amountMinor).toString().padStart(exponent + 1, '0');
  const major = digits.slice(0, digits.length - exponent);
  const minor = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${major}${minor} ${value.currency}`;
}

/**
 * Parse a human-entered major-unit string (e.g. "12.34") into minor units.
 * Used by input adapters only — never on an internal money path.
 */
export function moneyFromMajorString(value: string, currency: Currency): Money {
  const exponent = MINOR_UNIT_EXPONENT[currency];
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new MoneyError(`Not a decimal amount: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new MoneyError(`${currency} supports at most ${exponent} decimal places`);
  }
  const minor = BigInt(`${whole ?? '0'}${fraction.padEnd(exponent, '0')}`);
  return { amountMinor: sign === '-' ? -minor : minor, currency };
}
