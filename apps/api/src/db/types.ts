import pg from 'pg';

/**
 * PostgreSQL is the financial truth of HOWLOW. Two driver defaults are unsafe
 * for that role and are corrected here, once, for every connection:
 *
 *  - BIGINT (OID 20) is returned as a JS `number` by default, which silently
 *    loses precision above 2^53. We return the raw decimal string instead, so
 *    money can only ever be turned into a `bigint`.
 *  - NUMERIC (OID 1700) is likewise returned as a `number`. Same treatment.
 */
const OID_INT8 = 20;
const OID_NUMERIC = 1700;

let applied = false;

export function applySafeTypeParsers(): void {
  if (applied) return;
  pg.types.setTypeParser(OID_INT8, (value: string) => value);
  pg.types.setTypeParser(OID_NUMERIC, (value: string) => value);
  applied = true;
}
