import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, api, availableUnits, insertProduct, lapseHold, resetDb, startTestServer } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

describe('placing orders under concurrency', () => {
  it('ten customers racing for the last two units: exactly two holds, eight clean failures', async () => {
    // Repeat a few rounds: a race that only passes once is not proof.
    for (let round = 0; round < 5; round++) {
      await resetDb(ctx.db);
      const productId = await insertProduct(ctx.db, 'Last Samosas', 2000, 2);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => api(ctx, 'POST', '/orders', { items: [{ productId, quantity: 1 }] })),
      );

      const created = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status !== 201);
      expect(created).toHaveLength(2);
      expect(rejected).toHaveLength(8);
      for (const r of rejected) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
        expect(r.body.error.details.shortages).toEqual([{ productId, requested: 1, available: 0 }]);
      }

      const { rows } = await ctx.db.query<{ held: number; orders: number }>(
        `SELECT COALESCE(SUM(oi.quantity), 0)::int AS held, COUNT(DISTINCT o.id)::int AS orders
           FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE oi.product_id = $1`,
        [productId],
      );
      // Failed requests left no orders or items behind.
      expect(rows[0]).toEqual({ held: 2, orders: 2 });
      expect(await availableUnits(ctx, productId)).toBe(0);
    }
  });

  it('never oversells under a mixed burst of multi-product orders', async () => {
    const a = await insertProduct(ctx.db, 'A', 1000, 7);
    const b = await insertProduct(ctx.db, 'B', 1500, 5);

    // Lines listed in both orders (a,b) and (b,a) would deadlock without ordered locking.
    const requests = Array.from({ length: 40 }, (_, i) => {
      const items =
        i % 2 === 0
          ? [{ productId: a, quantity: 1 + (i % 3) }, { productId: b, quantity: 1 }]
          : [{ productId: b, quantity: 1 }, { productId: a, quantity: 1 }];
      return api(ctx, 'POST', '/orders', { items });
    });
    const results = await Promise.all(requests);

    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const heldA = results.filter((r) => r.status === 201).reduce(
      (sum, r) => sum + r.body.items.find((i: any) => i.productId === a).quantity, 0);
    const heldB = results.filter((r) => r.status === 201).length;
    expect(heldA).toBeLessThanOrEqual(7);
    expect(heldB).toBeLessThanOrEqual(5);
    expect(await availableUnits(ctx, a)).toBe(7 - heldA);
    expect(await availableUnits(ctx, b)).toBe(5 - heldB);
  });
});

describe('placing an order', () => {
  it('holds stock, totals in integer paise and reports expiresInSeconds', async () => {
    const chips = await insertProduct(ctx.db, 'Chips', 3000, 8);
    const coffee = await insertProduct(ctx.db, 'Coffee', 4550, 3);

    const res = await api(ctx, 'POST', '/orders', {
      items: [{ productId: chips, quantity: 2 }, { productId: coffee, quantity: 1 }, { productId: chips, quantity: 1 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.totalPaise).toBe(3 * 3000 + 4550);
    expect(res.body.expiresInSeconds).toBeGreaterThanOrEqual(118);
    expect(res.body.expiresInSeconds).toBeLessThanOrEqual(120);
    expect(await availableUnits(ctx, chips)).toBe(5);
    expect(await availableUnits(ctx, coffee)).toBe(2);
  });

  it('fails without holding anything when any line is short', async () => {
    const plenty = await insertProduct(ctx.db, 'Plenty', 1000, 10);
    const scarce = await insertProduct(ctx.db, 'Scarce', 1000, 1);

    const res = await api(ctx, 'POST', '/orders', {
      items: [{ productId: plenty, quantity: 3 }, { productId: scarce, quantity: 2 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await availableUnits(ctx, plenty)).toBe(10);
    expect(await availableUnits(ctx, scarce)).toBe(1);
  });

  it('rejects unknown products and invalid quantities', async () => {
    const unknown = await api(ctx, 'POST', '/orders', { items: [{ productId: 999, quantity: 1 }] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('PRODUCT_NOT_FOUND');

    const p = await insertProduct(ctx.db, 'P', 1000, 5);
    for (const quantity of [0, -1, 1.5]) {
      const bad = await api(ctx, 'POST', '/orders', { items: [{ productId: p, quantity }] });
      expect(bad.status).toBe(400);
    }
    expect((await api(ctx, 'POST', '/orders', { items: [] })).status).toBe(400);
  });

  it('releases units when the hold lapses and shows the order as expired', async () => {
    const productId = await insertProduct(ctx.db, 'Chikki', 1500, 2);
    const order = await api(ctx, 'POST', '/orders', { items: [{ productId, quantity: 2 }] });
    expect(await availableUnits(ctx, productId)).toBe(0);

    await lapseHold(ctx.db, order.body.id);

    // Availability recovers immediately, without waiting for any sweeper.
    expect(await availableUnits(ctx, productId)).toBe(2);
    const fetched = await api(ctx, 'GET', `/orders/${order.body.id}`);
    expect(fetched.body.status).toBe('expired');
    expect(fetched.body.expiresInSeconds).toBe(0);

    // And the freed units can be sold to someone else.
    const next = await api(ctx, 'POST', '/orders', { items: [{ productId, quantity: 2 }] });
    expect(next.status).toBe(201);
  });

  it('returns 404 for unknown or malformed order ids', async () => {
    expect((await api(ctx, 'GET', '/orders/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await api(ctx, 'GET', '/orders/not-a-uuid')).status).toBe(404);
  });
});
