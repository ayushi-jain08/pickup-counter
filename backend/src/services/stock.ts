import { Db, Tx } from '../db/pool';

/**
 * The single definition of "this order is holding stock", used by every query.
 *
 * - `pending` orders hold units until `expires_at`, evaluated lazily, so a lapsed
 *   hold stops counting the instant it lapses even if the sweeper hasn't run.
 * - `paid` orders keep holding until pickup, when the hold turns into a real
 *   stock decrement.
 * - `expired`, `needs_review` and `picked_up` hold nothing.
 *
 * clock_timestamp() (not now()) is deliberate: now() is frozen at transaction
 * start, which would be stale after waiting on a row lock. All time decisions use
 * the database clock, so app servers and clients cannot disagree about expiry.
 */
export const HOLDING_ORDER_SQL = `(o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > clock_timestamp()))`;

export interface LockedProduct {
  id: number;
  name: string;
  pricePaise: number;
  stock: number;
}

/**
 * Locks product rows FOR UPDATE in ascending id order. Everything that can turn
 * free units into held units (creating an order, accepting a payment) goes
 * through this, so such decisions are serialised per product. The fixed order
 * keeps transactions that touch several products from deadlocking.
 */
export async function lockProducts(tx: Tx, productIds: number[]): Promise<LockedProduct[]> {
  const { rows } = await tx.query<LockedProduct>(
    `SELECT id, name, price_paise AS "pricePaise", stock
       FROM products
      WHERE id = ANY($1::int[])
      ORDER BY id
        FOR UPDATE`,
    [productIds],
  );
  return rows;
}

/**
 * Units currently held per product, optionally ignoring one order.
 *
 * Must run as a separate statement *after* lockProducts: under READ COMMITTED
 * each statement takes a fresh snapshot, so this one sees every order committed
 * by whoever held the product locks before us.
 */
export async function heldUnits(
  tx: Tx,
  productIds: number[],
  excludeOrderId: string | null = null,
): Promise<Map<number, number>> {
  const { rows } = await tx.query<{ productId: number; held: number }>(
    `SELECT oi.product_id AS "productId", SUM(oi.quantity)::int AS held
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = ANY($1::int[])
        AND ${HOLDING_ORDER_SQL}
        AND ($2::uuid IS NULL OR o.id <> $2::uuid)
      GROUP BY oi.product_id`,
    [productIds, excludeOrderId],
  );
  return new Map(rows.map((r) => [r.productId, r.held]));
}

export interface ProductView {
  id: number;
  name: string;
  pricePaise: number;
  stock: number;
  availableUnits: number;
}

export async function listProducts(db: Db): Promise<ProductView[]> {
  const { rows } = await db.query<ProductView>(
    `SELECT p.id, p.name, p.price_paise AS "pricePaise", p.stock,
            p.stock - COALESCE(h.held, 0) AS "availableUnits"
       FROM products p
       LEFT JOIN (
             SELECT oi.product_id, SUM(oi.quantity)::int AS held
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
              WHERE ${HOLDING_ORDER_SQL}
              GROUP BY oi.product_id
            ) h ON h.product_id = p.id
      ORDER BY p.id`,
  );
  return rows;
}

export interface Shortage {
  productId: number;
  requested: number;
  available: number;
}

/** Compares requested quantities against locked stock minus existing holds. */
export function findShortages(
  requested: Map<number, number>,
  products: LockedProduct[],
  held: Map<number, number>,
): Shortage[] {
  const shortages: Shortage[] = [];
  for (const product of products) {
    const want = requested.get(product.id) ?? 0;
    const available = product.stock - (held.get(product.id) ?? 0);
    if (want > available) shortages.push({ productId: product.id, requested: want, available: Math.max(0, available) });
  }
  return shortages;
}
