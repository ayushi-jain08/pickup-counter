import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TestContext,
  api,
  availableUnits,
  createPaidOrder,
  insertProduct,
  lapseHold,
  resetDb,
  startTestServer,
  stockOf,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

describe('pickup claims', () => {
  it('two lockers claiming at the same moment: exactly one succeeds, the other gets 409', async () => {
    for (let round = 0; round < 5; round++) {
      await resetDb(ctx.db);
      const productId = await insertProduct(ctx.db, 'Cold Coffee', 6000, 6);
      const order = await createPaidOrder(ctx, productId, 2);

      const claims = await Promise.all([
        api(ctx, 'POST', `/orders/${order.id}/pickup-claim`),
        api(ctx, 'POST', `/orders/${order.id}/pickup-claim`),
      ]);

      expect(claims.map((c) => c.status).sort()).toEqual([200, 409]);
      expect(claims.find((c) => c.status === 200)!.body.status).toBe('picked_up');
      expect(claims.find((c) => c.status === 409)!.body.error.code).toBe('ALREADY_CLAIMED');
      // Stock was reduced exactly once.
      expect(await stockOf(ctx.db, productId)).toBe(4);
      expect(await availableUnits(ctx, productId)).toBe(4);
    }
  });

  it('many lockers at once still produce a single success', async () => {
    const productId = await insertProduct(ctx.db, 'Samosa', 2000, 10);
    const order = await createPaidOrder(ctx, productId, 3);

    const claims = await Promise.all(
      Array.from({ length: 10 }, () => api(ctx, 'POST', `/orders/${order.id}/pickup-claim`)),
    );

    expect(claims.filter((c) => c.status === 200)).toHaveLength(1);
    expect(claims.filter((c) => c.status === 409)).toHaveLength(9);
    expect(await stockOf(ctx.db, productId)).toBe(7);
  });

  it('turns the hold into a permanent decrement without changing availability', async () => {
    const productId = await insertProduct(ctx.db, 'Chips', 3000, 5);
    const order = await createPaidOrder(ctx, productId, 2);
    expect(await availableUnits(ctx, productId)).toBe(3);
    expect(await stockOf(ctx.db, productId)).toBe(5);

    await api(ctx, 'POST', `/orders/${order.id}/pickup-claim`);

    expect(await availableUnits(ctx, productId)).toBe(3);
    expect(await stockOf(ctx.db, productId)).toBe(3);
  });

  it('refuses unpaid and expired orders', async () => {
    const productId = await insertProduct(ctx.db, 'Chikki', 1500, 5);
    const unpaid = (await api(ctx, 'POST', '/orders', { items: [{ productId, quantity: 1 }] })).body;
    const res = await api(ctx, 'POST', `/orders/${unpaid.id}/pickup-claim`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_PAID');

    await lapseHold(ctx.db, unpaid.id);
    const expired = await api(ctx, 'POST', `/orders/${unpaid.id}/pickup-claim`);
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('ORDER_EXPIRED');

    expect(await stockOf(ctx.db, productId)).toBe(5);
  });

  it('returns 404 for an unknown order', async () => {
    const res = await api(ctx, 'POST', '/orders/00000000-0000-0000-0000-000000000000/pickup-claim');
    expect(res.status).toBe(404);
  });
});
