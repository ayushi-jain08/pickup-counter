# Pickup Counter

A self-service snack counter: pick items, pay by (simulated) UPI, collect from a locker.
Backend: Node.js + Express 5 + TypeScript + PostgreSQL 16 (raw SQL via `pg`). Frontend: React + Vite.

## Running it

Needs Docker only.

```bash
docker compose up --build
```

- Customer screen: http://localhost:8080
- API: http://localhost:3000 (also proxied at http://localhost:8080/api)
- PostgreSQL: `localhost:5433` (user/password/db `pickup`)

The catalogue (5 snacks) is seeded on first start. `docker compose down -v` resets everything.

### Paying for an order (simulated provider)

Place an order on the screen; the payment screen shows the order id and the exact command:

```bash
docker compose exec backend npm run send-webhook -- <orderId>
```

or from the host (after `npm install` in `backend/`): `npm run send-webhook -- <orderId>`.
It signs the body with `WEBHOOK_SECRET` (default `dev-webhook-secret`, same as compose).

| Option | Effect |
|---|---|
| *(none)* | Looks up the order and pays its exact total with a fresh event id |
| `--event evt_123` | Fixed event id: run twice to see a redelivery come back `duplicate: true` |
| `--amount 100` | Wrong amount -> order goes to `needs_review` |
| `--status failed` | A failed payment (order stays pending) |
| `--bad-signature` | Forged signature -> `401` |

Locker pickup: `curl -X POST localhost:3000/orders/<orderId>/pickup-claim`

Set `HOLD_SECONDS=20 docker compose up` to try expiry without waiting two minutes.

## Running the tests

The tests run against a real PostgreSQL (the compose `db` service, separate `pickup_test` database). No mocks.

```bash
docker compose --profile test run --rm tests
```

Or from the host, with the db container running (`docker compose up -d db`):

```bash
cd backend && npm install && npm test
```

24 tests in [backend/test](backend/test). They boot the real Express app on a random port and hit it over HTTP:

| Brief requirement | Test |
|---|---|
| 10 customers, last 2 units | `orders.test.ts` "ten customers racing…": 10 parallel `POST /orders`, exactly 2 `201`, 8 `409 INSUFFICIENT_STOCK`, 2 units held in the DB, failed requests leave no rows. Runs 5 rounds. |
| Same webhook twice | `webhook.test.ts` "the same event sent twice…" (sequential) and "…delivered concurrently" (8 at once): one event row, `paidAt` unchanged, one non-duplicate response. |
| Two simultaneous pickups | `pickup.test.ts` "two lockers…": `[200, 409]`, stock reduced exactly once. 5 rounds, plus a 10-locker variant. |

Also covered: mixed multi-product bursts (lines in opposite orders, which would deadlock without ordered locking), expiry releasing stock, bad/tampered signatures, amount mismatch, failed payments, unknown orders, both late-payment outcomes, and late payments racing new orders for the same units.

**How I checked the tests can fail.** Concurrency tests that always pass prove nothing, so I broke the code on purpose and re-ran them:
- Removing `FOR UPDATE` from the product lock: the 10-customer test fails, all 10 orders succeed for 2 units.
- Letting the pickup `UPDATE` also match `picked_up`: the two-locker test fails with `[200, 200]`.

Both were reverted. I also ran the full flow by hand through Docker (order -> webhook -> replay -> forged signature -> two parallel claims), see "Paying for an order" above.

## How it works

### Stock and holds

`products.stock` is the physical count; only a pickup changes it. Holds are not stored as a counter but derived from orders, using one SQL condition used everywhere ([stock.ts](backend/src/services/stock.ts)):

```
holding = status = 'paid'  OR  (status = 'pending' AND expires_at > clock_timestamp())
available = stock - SUM(quantity of holding orders)
```

So a hold stops counting the instant it lapses. The sweeper that sets `status = 'expired'` every 5s (and `GET /orders/:id`, which does it on read) is bookkeeping only; correctness never waits for it.

### Concurrency

Everything that can turn free units into held units goes through `lockProducts`: `SELECT … FOR UPDATE` on the product rows, **in ascending id order** (so multi-product orders can't deadlock). That covers creating an order and accepting a payment.

- **Create order** (one transaction): lock products, *then* sum holds in a separate statement, check, insert. Under READ COMMITTED each statement gets a fresh snapshot, so the sum sees every order committed by whoever held the lock before. Computing it in the same statement as the lock would use a stale snapshot. A shortfall throws, the transaction rolls back, nothing is held.
- **Pickup** is a single conditional `UPDATE orders SET status='picked_up' WHERE id=$1 AND status='paid'`. The second locker blocks on the row lock, re-checks the `WHERE` after the first commits, matches 0 rows and gets `409 ALREADY_CLAIMED`. Stock is decremented in the same transaction, with `CHECK (stock >= 0)` as a backstop.
- **Webhook** locks the order row, then its products, then decides. Because it holds the same product locks as order creation, "is my hold still valid?" and "can someone else take these units?" are never answered at the same time.

Lock order is always order row -> product rows (or products only), so there is no cycle.

### Time

All time decisions use the **database clock** (`clock_timestamp()`, not `now()`, which is frozen at transaction start and would be stale after waiting on a lock). The app server's clock and the kiosk's clock are never used for expiry.

`expiresInSeconds` is computed by the database in the read after commit, floored to whole seconds, and is `0` unless the order is pending.

**The countdown on the screen** ([useServerCountdown.ts](frontend/src/useServerCountdown.ts)) never reads `Date.now()`. The kiosk clock can be minutes wrong, so comparing it with `expiresAt` would be wrong too. It only uses durations: `deadline = performance.now() at request send + expiresInSeconds`. `performance.now()` is monotonic and unaffected by the wall-clock setting. Anchoring at send time and flooring both make the estimate a lower bound, so the screen can end slightly early, never late. Every poll (every 2s) gives a new lower bound and we keep the latest. When the timer hits 0 the screen shows "Checking payment…" and polls at once; the server's status decides "expired", not the timer.

### Webhook

1. The signature is checked over the **raw bytes** (`express.raw`), before parsing, with `timingSafeEqual`. Mismatch -> `401`, nothing recorded.
2. Idempotency: `INSERT INTO payment_events … ON CONFLICT (event_id) DO NOTHING` in the same transaction as the order change. A redelivery returns the stored outcome with `duplicate: true` and touches nothing. Two concurrent deliveries: the second `INSERT` waits on the first's uncommitted key, then sees the conflict. If processing fails, the event insert rolls back too, so the provider's retry is processed normally.
3. Outcomes, recorded on the event row and returned in the response:

| Situation | Result |
|---|---|
| Valid capture, hold still active | `paid` |
| Amount differs from total | `needs_review` (`amount_mismatch`), never paid |
| Capture after the hold lapsed, units still free | `paid` (outcome `paid_late`) |
| Capture after the hold lapsed, units taken | `needs_review` (`late_payment_stock_unavailable`) |
| A different event id captures an already-paid order | ignored, recorded as `ignored_already_paid` |
| `status: "failed"` | recorded, order unchanged |
| Unknown / malformed `orderId` | `200`, recorded as `unknown_order` (retrying won't help, so we acknowledge it) |
| Signed body that fails validation | `400` |

## Decisions

**Late payment (valid capture after the hold expired).** I re-check stock at that moment, under the same product locks as order creation:
- If the units are still free, the order is marked **paid**. The customer has paid and the goods are there, so the best outcome is to give them their snacks. Refunding and making them order again would be worse for everyone.
- If any unit has gone to someone else, it becomes **needs_review** with reason `late_payment_stock_unavailable`. A human refunds or offers a swap.

The one thing I won't do is oversell: an order that has a hold or is paid is never overridden by a late payer. Auto-refund would also be reasonable, but there's no refund API to call here, and a review queue is safer for real money than silently dropping it. The screen's "expired" message tells the customer this.

**`needs_review` holds no stock.** The order can't be collected until a human resolves it, and blocking units indefinitely on an unresolved review would hide stock from paying customers. The resolver re-reserves or refunds.

**Paid orders keep holding until pickup.** The brief says available = stock minus *unpaid* holds and pickup reduces stock. Read literally, a paid-but-not-collected order would free its units for resale. I count paid orders as holding, otherwise a paid customer could find their locker empty.

**Errors.** Insufficient stock is `409 INSUFFICIENT_STOCK` with `{productId, requested, available}` per short line. Claiming an order in the wrong state is `409` with a specific code (`ALREADY_CLAIMED`, `ORDER_NOT_PAID`, `ORDER_EXPIRED`, `ORDER_NEEDS_REVIEW`). Unknown ids are `404`.

**Raw SQL, no ORM.** The correctness lives in the exact locking statements, so I wanted them visible rather than generated.

## Assumptions

- Prices are snapshotted on `order_items` at order time; the total is integer paise, computed in integer arithmetic (and displayed with integer maths on the screen too).
- Repeated product ids in one order are merged. Quantity per line is 1-100.
- One event id is one provider event. A redelivery with the same id but a different body is treated as the duplicate it claims to be (first one wins).
- The locker endpoint is unauthenticated, like the rest of the API. In reality the lockers would authenticate.
- No user accounts; the order id is the customer's reference (the screen shows its first 8 characters as an order code).
- `expiresInSeconds` is an integer (floored).

## What I'd do next

- An operator API/screen for `needs_review` (refund, or re-reserve and mark paid), and a refund flow for double captures (`ignored_already_paid`).
- An expiry for paid orders never collected (e.g. refund and release after a day).
- Locker authentication, and a timestamp in the signed webhook payload to reject old replays.
- A browser test for the countdown with a faked skewed wall clock. I reasoned and code-reviewed this but only checked it by hand, not with an automated test.
- Structured logging/metrics on webhook outcomes, and alerts on `needs_review`.
- Push status to the screen (SSE) instead of 2s polling.

## Layout

```
backend/
  src/services/stock.ts     holding rule, product locks, availability
  src/services/orders.ts    create, read/expire, pickup claim
  src/services/payments.ts  webhook idempotency and outcomes
  src/routes/*              thin Express handlers
  src/db/                   pool + transactions, migrations, seed
  scripts/send-webhook.ts   signed webhook sender
  test/                     integration tests against real PostgreSQL
frontend/src/
  Shop.tsx, Payment.tsx     the two screens
  useServerCountdown.ts     clock-skew-proof countdown
```
