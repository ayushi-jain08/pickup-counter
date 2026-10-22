import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Pool } from 'pg';
import { createApp } from '../src/app';
import { createPool } from '../src/db/pool';
import { signPayload } from '../src/signature';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://pickup:pickup@localhost:5433/pickup_test';
export const TEST_SECRET = 'test-webhook-secret';

export interface TestContext {
  db: Pool;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boots the real Express app on an ephemeral port against the real test database. */
export async function startTestServer(holdSeconds = 120): Promise<TestContext> {
  // More connections than concurrent requests, so the pool itself never serialises them.
  const db = createPool(TEST_DATABASE_URL, 40);
  const app = createApp({ db, webhookSecret: TEST_SECRET, holdSeconds });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
    },
  };
}

// DELETE rather than TRUNCATE: on tiny tables it is ~100x faster (TRUNCATE
// fsyncs new relation files, which is slow on Docker Desktop volumes).
export async function resetDb(db: Pool): Promise<void> {
  await db.query('DELETE FROM payment_events; DELETE FROM order_items; DELETE FROM orders; DELETE FROM products;');
}

export async function insertProduct(db: Pool, name: string, pricePaise: number, stock: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    'INSERT INTO products (name, price_paise, stock) VALUES ($1, $2, $3) RETURNING id',
    [name, pricePaise, stock],
  );
  return rows[0].id;
}

export interface JsonResponse<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(ctx: TestContext, method: string, path: string, body?: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export async function sendWebhook(
  ctx: TestContext,
  event: { eventId: string; orderId: string; amountPaise: number; status: string },
  signature?: string,
): Promise<JsonResponse> {
  const raw = JSON.stringify(event);
  const res = await fetch(`${ctx.baseUrl}/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature ?? signPayload(TEST_SECRET, raw) },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

export async function availableUnits(ctx: TestContext, productId: number): Promise<number> {
  const { body } = await api(ctx, 'GET', '/products');
  return body.products.find((p: { id: number }) => p.id === productId).availableUnits;
}

export async function stockOf(db: Pool, productId: number): Promise<number> {
  const { rows } = await db.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [productId]);
  return rows[0].stock;
}

/** Simulates the passage of time by moving an order's hold into the past. */
export async function lapseHold(db: Pool, orderId: string): Promise<void> {
  await db.query(`UPDATE orders SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [orderId]);
}

export async function createPaidOrder(ctx: TestContext, productId: number, quantity: number) {
  const order = await api(ctx, 'POST', '/orders', { items: [{ productId, quantity }] });
  await sendWebhook(ctx, {
    eventId: `evt_paid_${order.body.id}`,
    orderId: order.body.id,
    amountPaise: order.body.totalPaise,
    status: 'captured',
  });
  return order.body;
}
