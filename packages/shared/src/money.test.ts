import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  formatMoney,
  MoneyError,
  moneyFromMajorString,
  moneyFromMinorString,
  moneyToMinorString,
  money,
  subtractMoney,
} from './money.js';

describe('money', () => {
  it('adds and subtracts without losing precision on large values', () => {
    const a = money(9007199254740993n, 'USD'); // beyond Number.MAX_SAFE_INTEGER
    const b = money(1n, 'USD');
    expect(moneyToMinorString(addMoney(a, b))).toBe('9007199254740994');
    expect(moneyToMinorString(subtractMoney(a, b))).toBe('9007199254740992');
  });

  it('refuses to mix currencies', () => {
    expect(() => addMoney(money(1n, 'USD'), money(1n, 'EUR'))).toThrow(MoneyError);
    expect(() => compareMoney(money(1n, 'USD'), money(1n, 'ETB'))).toThrow(MoneyError);
  });

  it('parses minor-unit strings and rejects non-integers', () => {
    expect(moneyFromMinorString('1250', 'USD').amountMinor).toBe(1250n);
    expect(moneyFromMinorString('-1', 'USD').amountMinor).toBe(-1n);
    expect(() => moneyFromMinorString('12.50', 'USD')).toThrow(MoneyError);
    expect(() => moneyFromMinorString('', 'USD')).toThrow(MoneyError);
  });

  it('parses major-unit input into minor units', () => {
    expect(moneyFromMajorString('12.34', 'USD').amountMinor).toBe(1234n);
    expect(moneyFromMajorString('12.3', 'USD').amountMinor).toBe(1230n);
    expect(moneyFromMajorString('12', 'USD').amountMinor).toBe(1200n);
    expect(moneyFromMajorString('-0.05', 'USD').amountMinor).toBe(-5n);
    expect(() => moneyFromMajorString('12.345', 'USD')).toThrow(MoneyError);
  });

  it('formats for display only', () => {
    expect(formatMoney(money(1234n, 'USD'))).toBe('12.34 USD');
    expect(formatMoney(money(5n, 'EUR'))).toBe('0.05 EUR');
    expect(formatMoney(money(0n, 'ETB'))).toBe('0.00 ETB');
    expect(formatMoney(money(-1234n, 'USD'))).toBe('-12.34 USD');
  });

  it('orders amounts', () => {
    expect(compareMoney(money(1n, 'USD'), money(2n, 'USD'))).toBe(-1);
    expect(compareMoney(money(2n, 'USD'), money(2n, 'USD'))).toBe(0);
    expect(compareMoney(money(3n, 'USD'), money(2n, 'USD'))).toBe(1);
  });
});
