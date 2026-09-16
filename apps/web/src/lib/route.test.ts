import { describe, expect, it } from 'vitest';
import { parsePath, pathOf } from './route.js';

/**
 * Routing, which matters because auction URLs are shared.
 *
 * A link someone sends must open the same auction when it is pasted back, so
 * parse and build have to agree.
 */
describe('parsing a path', () => {
  it('reads the views the site exposes', () => {
    expect(parsePath('/')).toEqual({ name: 'home' });
    expect(parsePath('/auctions')).toEqual({ name: 'auctions' });
    expect(parsePath('/wallet')).toEqual({ name: 'wallet' });
    expect(parsePath('/seller')).toEqual({ name: 'seller' });
    expect(parsePath('/admin')).toEqual({ name: 'admin' });
  });

  it('reads an auction reference, by slug or by id', () => {
    expect(parsePath('/auctions/iphone-16-pro')).toEqual({
      name: 'auction',
      reference: 'iphone-16-pro',
    });
    expect(parsePath('/auctions/11111111-1111-4111-8111-111111111111')).toEqual({
      name: 'auction',
      reference: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('tolerates trailing slashes and an empty reference', () => {
    expect(parsePath('/auctions/')).toEqual({ name: 'auctions' });
    expect(parsePath('//auctions//')).toEqual({ name: 'auctions' });
  });

  it('falls back to home for anything unknown', () => {
    expect(parsePath('/nowhere')).toEqual({ name: 'home' });
    expect(parsePath('')).toEqual({ name: 'home' });
  });
});

describe('building a path', () => {
  it('round-trips every route', () => {
    const routes = [
      { name: 'home' },
      { name: 'auctions' },
      { name: 'auction', reference: 'iphone-16-pro' },
      { name: 'wallet' },
      { name: 'seller' },
      { name: 'admin' },
    ] as const;

    for (const route of routes) {
      expect(parsePath(pathOf(route))).toEqual(route);
    }
  });

  /** A reference with characters needing escaping still round-trips. */
  it('escapes and unescapes a reference', () => {
    const route = { name: 'auction', reference: 'a b/c' } as const;
    const path = pathOf(route);
    expect(path).not.toContain(' ');
    expect(parsePath(path)).toEqual(route);
  });
});
