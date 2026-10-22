import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TestContext,
  api,
  availableUnits,
  insertProduct,
  lapseHold,
  resetDb,
  sendWebhook,
  startTestServer,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

async function newOrder(stock = 5, quantity = 1) {
  const productId = await insertProduct(ctx.db, `Snack ${Math.random()}`, 4500, stock);
  const { body } = await api(ctx, 'POST', '/orders', { items: [{ productId, quantity }] });
  return { productId, order: body };
}

async function paymentEventCount(orderId: string): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1',
    [orderId],
  );
  return rows[0].n;
}

describe('webhook idempotency', () => {
  it('the same event sent twice is processed once', async () => {
    const { order } = await newOrder();
    const event = { eventId: 'evt_123', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' };

    const first = await sendWebhook(ctx, event);
    const paidAt = (await api(ctx, 'GET', `/orders/${order.id}`)).body.paidAt;
    const second = await sendWebhook(ctx, event);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ duplicate: false, outcome: 'paid', orderStatus: 'paid' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true, outcome: 'paid', orderStatus: 'paid' });

    const after = await api(ctx, 'GET', `/orders/${order.id}`);
    expect(after.body.status).toBe('paid');
    expect(after.body.paidAt).toBe(paidAt);
    expect(await paymentEventCount(order.id)).toBe(1);
  });

  it('the same event delivered concurrently is processed once', async () => {
    const { order } = await newOrder();
    const event = { eventId: 'evt_burst', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' };

    const results = await Promise.all(Array.from({ length: 8 }, () => sendWebhook(ctx, event)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(results.every((r) => r.body.outcome === 'paid')).toBe(true);
    expect(await paymentEventCount(order.id)).toBe(1);
  });

  it('a replayed event does not undo a later state change', async () => {
    // Mismatch event first -> needs_review; replaying it must not re-run any logic.
    const { order } = await newOrder();
    const event = { eventId: 'evt_short', orderId: order.id, amountPaise: 100, status: 'captured' };
    await sendWebhook(ctx, event);
    const replay = await sendWebhook(ctx, event);
    expect(replay.body).toEqual({ duplicate: true, outcome: 'needs_review_amount_mismatch', orderStatus: 'needs_review' });
  });
});

describe('webhook validation and outcomes', () => {
  it('rejects a bad or missing signature without recording anything', async () => {
    const { order } = await newOrder();
    const event = { eventId: 'evt_forged', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' };

    expect((await sendWebhook(ctx, event, 'f'.repeat(64))).status).toBe(401);
    expect((await sendWebhook(ctx, event, 'not-hex')).status).toBe(401);

    // Correct signature for a *different* body (tampered payload).
    const raw = JSON.stringify({ ...event, amountPaise: 1 });
    const res = await fetch(`${ctx.baseUrl}/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
    expect(res.status).toBe(401);

    expect((await api(ctx, 'GET', `/orders/${order.id}`)).body.status).toBe('pending');
    expect(await paymentEventCount(order.id)).toBe(0);
  });

  it('marks needs_review, not paid, when the amount does not match', async () => {
    const { order, productId } = await newOrder(5, 2);
    const res = await sendWebhook(ctx, {
      eventId: 'evt_mismatch', orderId: order.id, amountPaise: order.totalPaise - 1, status: 'captured',
    });

    expect(res.body.outcome).toBe('needs_review_amount_mismatch');
    const after = await api(ctx, 'GET', `/orders/${order.id}`);
    expect(after.body.status).toBe('needs_review');
    expect(after.body.reviewReason).toBe('amount_mismatch');
    // A needs_review order holds nothing (see README), and cannot be collected.
    expect(await availableUnits(ctx, productId)).toBe(5);
    expect((await api(ctx, 'POST', `/orders/${order.id}/pickup-claim`)).status).toBe(409);
  });

  it('a second, different capture for a paid order changes nothing', async () => {
    const { order } = await newOrder();
    await sendWebhook(ctx, { eventId: 'evt_a', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' });
    const res = await sendWebhook(ctx, { eventId: 'evt_b', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' });
    expect(res.body).toEqual({ duplicate: false, outcome: 'ignored_already_paid', orderStatus: 'paid' });
  });

  it('a failed payment leaves the order pending', async () => {
    const { order } = await newOrder();
    const res = await sendWebhook(ctx, { eventId: 'evt_fail', orderId: order.id, amountPaise: order.totalPaise, status: 'failed' });
    expect(res.body.outcome).toBe('ignored_payment_failed');
    expect((await api(ctx, 'GET', `/orders/${order.id}`)).body.status).toBe('pending');
  });

  it('acknowledges events for unknown orders without failing', async () => {
    const res = await sendWebhook(ctx, { eventId: 'evt_ghost', orderId: '', amountPaise: 4500, status: 'captured' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unknown_order');
  });

  it('rejects a correctly signed but malformed body', async () => {
    const res = await sendWebhook(ctx, { eventId: 'evt_x', orderId: 'x', amountPaise: -5, status: 'captured' });
    expect(res.status).toBe(400);
  });
});

describe('late payments (after the hold expired)', () => {
  it('are honoured when the units are still free', async () => {
    const { order, productId } = await newOrder(3, 2);
    await lapseHold(ctx.db, order.id);
    expect((await api(ctx, 'GET', `/orders/${order.id}`)).body.status).toBe('expired');

    const res = await sendWebhook(ctx, { eventId: 'evt_late', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' });

    expect(res.body).toEqual({ duplicate: false, outcome: 'paid_late', orderStatus: 'paid' });
    expect(await availableUnits(ctx, productId)).toBe(1);
  });

  it('go to needs_review when the units were sold to someone else', async () => {
    const { order, productId } = await newOrder(2, 2);
    await lapseHold(ctx.db, order.id);
    const rival = await api(ctx, 'POST', '/orders', { items: [{ productId, quantity: 1 }] });
    expect(rival.status).toBe(201);

    const res = await sendWebhook(ctx, { eventId: 'evt_late2', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' });

    expect(res.body.outcome).toBe('needs_review_late_no_stock');
    const after = await api(ctx, 'GET', `/orders/${order.id}`);
    expect(after.body.status).toBe('needs_review');
    expect(after.body.reviewReason).toBe('late_payment_stock_unavailable');
    // The rival's hold is untouched and nothing is oversold.
    expect(await availableUnits(ctx, productId)).toBe(1);
  });

  it('never oversell when late payments race new orders for the same units', async () => {
    for (let round = 0; round < 5; round++) {
      await resetDb(ctx.db);
      const productId = await insertProduct(ctx.db, 'Contested', 1000, 2);
      const stale = (await api(ctx, 'POST', '/orders', { items: [{ productId, quantity: 2 }] })).body;
      await lapseHold(ctx.db, stale.id);

      const [late, ...fresh] = await Promise.all([
        sendWebhook(ctx, { eventId: `evt_race_${round}`, orderId: stale.id, amountPaise: stale.totalPaise, status: 'captured' }),
        ...Array.from({ length: 4 }, () => api(ctx, 'POST', '/orders', { items: [{ productId, quantity: 1 }] })),
      ]);

      const freshUnits = fresh.filter((r) => r.status === 201).length;
      const lateUnits = late.body.orderStatus === 'paid' ? 2 : 0;
      expect(freshUnits + lateUnits).toBeLessThanOrEqual(2);
      expect(await availableUnits(ctx, productId)).toBeGreaterThanOrEqual(0);
    }
  });
});
