import { Db, Tx, withTransaction } from '../db/pool';
import { badRequest, conflict, notFound } from '../errors';
import { findShortages, heldUnits, lockProducts } from './stock';

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_review' | 'picked_up';

export interface OrderItemInput {
  productId: number;
  quantity: number;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  items: { productId: number; name: string; quantity: number; unitPricePaise: number }[];
  createdAt: string;
  expiresAt: string;
  /** Seconds left on the hold, measured by the database clock. 0 unless pending. */
  expiresInSeconds: number;
  paidAt: string | null;
  pickedUpAt: string | null;
  reviewReason: string | null;
}

const MAX_INT4 = 2_147_483_647;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

/** Collapses repeated product ids into one line each. */
function mergeItems(items: OrderItemInput[]): Map<number, number> {
  const merged = new Map<number, number>();
  for (const item of items) merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  return merged;
}

export async function createOrder(db: Db, holdSeconds: number, items: OrderItemInput[]): Promise<OrderView> {
  const requested = mergeItems(items);
  const productIds = [...requested.keys()].sort((a, b) => a - b);

  const orderId = await withTransaction(db, async (tx) => {
    const products = await lockProducts(tx, productIds);
    if (products.length !== productIds.length) {
      const found = new Set(products.map((p) => p.id));
      throw notFound('PRODUCT_NOT_FOUND', 'One or more products do not exist', {
        productIds: productIds.filter((id) => !found.has(id)),
      });
    }

    const shortages = findShortages(requested, products, await heldUnits(tx, productIds));
    if (shortages.length > 0) {
      // Throwing rolls the transaction back, so nothing is held.
      throw conflict('INSUFFICIENT_STOCK', 'Not enough stock for one or more products', { shortages });
    }

    const totalPaise = products.reduce((sum, p) => sum + p.pricePaise * requested.get(p.id)!, 0);
    if (totalPaise > MAX_INT4) throw badRequest('ORDER_TOO_LARGE', 'Order total is too large');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO orders (status, total_paise, expires_at)
       VALUES ('pending', $1, clock_timestamp() + make_interval(secs => $2))
       RETURNING id`,
      [totalPaise, holdSeconds],
    );
    const id = rows[0].id;
    await tx.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_paise)
       SELECT $1, * FROM unnest($2::int[], $3::int[], $4::int[])`,
      [id, products.map((p) => p.id), products.map((p) => requested.get(p.id)!), products.map((p) => p.pricePaise)],
    );
    return id;
  });

  // Read back after commit so expiresInSeconds is measured as late as possible.
  return (await getOrder(db, orderId))!;
}

/**
 * Persists `expired` for a lapsed pending order. Purely bookkeeping: holds already
 * stop counting at expires_at (see HOLDING_ORDER_SQL), with or without this.
 */
async function expireIfLapsed(db: Db | Tx, orderId: string): Promise<void> {
  await db.query(
    `UPDATE orders SET status = 'expired'
      WHERE id = $1 AND status = 'pending' AND expires_at <= clock_timestamp()`,
    [orderId],
  );
}

/** Background sweeper: marks every lapsed pending order as expired. */
export async function expireLapsedOrders(db: Db): Promise<number> {
  const result = await db.query(
    `UPDATE orders SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= clock_timestamp()`,
  );
  return result.rowCount ?? 0;
}

export async function getOrder(db: Db | Tx, orderId: string): Promise<OrderView | null> {
  if (!isUuid(orderId)) return null;
  await expireIfLapsed(db, orderId);
  const { rows } = await db.query<OrderView>(
    `SELECT o.id, o.status, o.total_paise AS "totalPaise",
            o.created_at AS "createdAt", o.expires_at AS "expiresAt",
            o.paid_at AS "paidAt", o.picked_up_at AS "pickedUpAt", o.review_reason AS "reviewReason",
            CASE WHEN o.status = 'pending'
                 THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (o.expires_at - clock_timestamp()))))::int
                 ELSE 0 END AS "expiresInSeconds",
            COALESCE(
              (SELECT json_agg(json_build_object(
                        'productId', oi.product_id, 'name', p.name,
                        'quantity', oi.quantity, 'unitPricePaise', oi.unit_price_paise)
                      ORDER BY oi.product_id)
                 FROM order_items oi JOIN products p ON p.id = oi.product_id
                WHERE oi.order_id = o.id),
              '[]'::json) AS items
       FROM orders o
      WHERE o.id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

/**
 * Locker pickup. The conditional UPDATE is the whole race guard: when two
 * lockers claim at once, the second blocks on the row lock, re-checks
 * `status = 'paid'` after the first commits, matches nothing, and gets a 409.
 */
export async function claimPickup(db: Db, orderId: string): Promise<OrderView> {
  if (!isUuid(orderId)) throw notFound('ORDER_NOT_FOUND', 'Order not found');

  await withTransaction(db, async (tx) => {
    const claimed = await tx.query(
      `UPDATE orders SET status = 'picked_up', picked_up_at = clock_timestamp()
        WHERE id = $1 AND status = 'paid'
        RETURNING id`,
      [orderId],
    );
    if (claimed.rowCount === 0) throw await explainUnclaimable(tx, orderId);

    // The paid hold becomes a permanent decrement. Available units don't change
    // (stock and held drop by the same amount); the CHECK (stock >= 0) is a backstop.
    const { rows: items } = await tx.query<{ productId: number }>(
      'SELECT product_id AS "productId" FROM order_items WHERE order_id = $1',
      [orderId],
    );
    await lockProducts(tx, items.map((i) => i.productId));
    await tx.query(
      `UPDATE products p SET stock = p.stock - oi.quantity
         FROM order_items oi
        WHERE oi.order_id = $1 AND oi.product_id = p.id`,
      [orderId],
    );
  });

  return (await getOrder(db, orderId))!;
}

async function explainUnclaimable(tx: Tx, orderId: string) {
  await expireIfLapsed(tx, orderId);
  const { rows } = await tx.query<{ status: OrderStatus }>('SELECT status FROM orders WHERE id = $1', [orderId]);
  const status = rows[0]?.status;
  switch (status) {
    case undefined:
      return notFound('ORDER_NOT_FOUND', 'Order not found');
    case 'picked_up':
      return conflict('ALREADY_CLAIMED', 'This order has already been collected');
    case 'expired':
      return conflict('ORDER_EXPIRED', 'This order expired before it was paid');
    case 'needs_review':
      return conflict('ORDER_NEEDS_REVIEW', 'This order is waiting for staff review');
    default:
      return conflict('ORDER_NOT_PAID', 'This order has not been paid');
  }
}
