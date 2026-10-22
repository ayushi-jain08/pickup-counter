import { z } from 'zod';
import { Db, Tx, withTransaction } from '../db/pool';
import { OrderStatus, isUuid } from './orders';
import { findShortages, heldUnits, lockProducts } from './stock';

export const webhookEventSchema = z.object({
  eventId: z.string().min(1).max(200),
  orderId: z.string().max(200),
  amountPaise: z.number().int().nonnegative().max(2_147_483_647),
  status: z.enum(['captured', 'failed']),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/** What a webhook event did. Stored on the event row and echoed in the response. */
export type WebhookOutcome =
  | 'paid'
  | 'paid_late' // captured after the hold lapsed, stock was still free, so we honoured it
  | 'needs_review_amount_mismatch'
  | 'needs_review_late_no_stock' // captured after the hold lapsed and the units are gone
  | 'ignored_already_paid' // a second, different capture for a paid order (double charge)
  | 'ignored_in_review'
  | 'ignored_payment_failed'
  | 'unknown_order';

export interface WebhookResult {
  duplicate: boolean;
  outcome: WebhookOutcome;
  orderStatus: OrderStatus | null;
}

/**
 * Applies one provider event exactly once.
 *
 * Idempotency: the event row is inserted first, keyed by eventId. A redelivery
 * hits ON CONFLICT DO NOTHING and returns the stored outcome without touching
 * the order. If two deliveries race, the second INSERT waits on the first's
 * uncommitted key and then sees the conflict. If processing throws, the insert
 * rolls back with it, so the provider's retry gets processed normally.
 */
export async function processWebhook(db: Db, event: WebhookEvent): Promise<WebhookResult> {
  return withTransaction(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO payment_events (event_id, order_id, amount_paise, status, outcome, payload)
       VALUES ($1, $2, $3, $4, 'processing', $5)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.orderId, event.amountPaise, event.status, JSON.stringify(event)],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await tx.query<{ outcome: WebhookOutcome; orderStatus: OrderStatus | null }>(
        `SELECT e.outcome, o.status AS "orderStatus"
           FROM payment_events e
           LEFT JOIN orders o ON o.id::text = e.order_id
          WHERE e.event_id = $1`,
        [event.eventId],
      );
      return { duplicate: true, ...rows[0] };
    }

    const { outcome, orderStatus } = await applyEvent(tx, event);
    await tx.query('UPDATE payment_events SET outcome = $2 WHERE event_id = $1', [event.eventId, outcome]);
    return { duplicate: false, outcome, orderStatus };
  });
}

async function applyEvent(
  tx: Tx,
  event: WebhookEvent,
): Promise<{ outcome: WebhookOutcome; orderStatus: OrderStatus | null }> {
  if (!isUuid(event.orderId)) return { outcome: 'unknown_order', orderStatus: null };

  // Lock order first, then its products (same order as pickup) to avoid deadlocks.
  const { rows } = await tx.query<{ status: OrderStatus; totalPaise: number }>(
    'SELECT status, total_paise AS "totalPaise" FROM orders WHERE id = $1 FOR UPDATE',
    [event.orderId],
  );
  const order = rows[0];
  if (!order) return { outcome: 'unknown_order', orderStatus: null };

  const unchanged = (outcome: WebhookOutcome) => ({ outcome, orderStatus: order.status });

  if (event.status === 'failed') return unchanged('ignored_payment_failed');
  if (order.status === 'paid' || order.status === 'picked_up') return unchanged('ignored_already_paid');
  if (order.status === 'needs_review') return unchanged('ignored_in_review');

  // From here the order is pending or expired and money was captured.
  if (event.amountPaise !== order.totalPaise) {
    await markNeedsReview(tx, event.orderId, 'amount_mismatch');
    return { outcome: 'needs_review_amount_mismatch', orderStatus: 'needs_review' };
  }

  // Take the same product locks as order creation, so "is my hold still valid?"
  // and "may I take these units?" can never be answered concurrently.
  const { rows: items } = await tx.query<{ productId: number; quantity: number }>(
    'SELECT product_id AS "productId", quantity FROM order_items WHERE order_id = $1',
    [event.orderId],
  );
  const productIds = items.map((i) => i.productId);
  const products = await lockProducts(tx, productIds);

  const { rows: holdRows } = await tx.query<{ holding: boolean }>(
    `SELECT (status = 'pending' AND expires_at > clock_timestamp()) AS holding FROM orders WHERE id = $1`,
    [event.orderId],
  );
  if (holdRows[0].holding) {
    await markPaid(tx, event.orderId, event.eventId);
    return { outcome: 'paid', orderStatus: 'paid' };
  }

  // Late payment: the hold lapsed, so its units may have been sold. Honour the
  // payment only if the units are still free right now; never oversell.
  const requested = new Map(items.map((i) => [i.productId, i.quantity]));
  const shortages = findShortages(requested, products, await heldUnits(tx, productIds, event.orderId));
  if (shortages.length === 0) {
    await markPaid(tx, event.orderId, event.eventId);
    return { outcome: 'paid_late', orderStatus: 'paid' };
  }
  await markNeedsReview(tx, event.orderId, 'late_payment_stock_unavailable');
  return { outcome: 'needs_review_late_no_stock', orderStatus: 'needs_review' };
}

async function markPaid(tx: Tx, orderId: string, eventId: string): Promise<void> {
  await tx.query(
    `UPDATE orders SET status = 'paid', paid_at = clock_timestamp(), paid_event_id = $2 WHERE id = $1`,
    [orderId, eventId],
  );
}

async function markNeedsReview(tx: Tx, orderId: string, reason: string): Promise<void> {
  await tx.query(`UPDATE orders SET status = 'needs_review', review_reason = $2 WHERE id = $1`, [orderId, reason]);
}
