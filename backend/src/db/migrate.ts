import { Pool } from 'pg';

interface Migration {
  id: string;
  sql: string;
}

// Kept inline (rather than .sql files) so the compiled build needs no asset copying.
const migrations: Migration[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE products (
        id           SERIAL PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        price_paise  INTEGER NOT NULL CHECK (price_paise > 0),
        -- Physical units in the counter. Only a pickup decrements it.
        stock        INTEGER NOT NULL CHECK (stock >= 0)
      );

      CREATE TABLE orders (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status        TEXT NOT NULL
                      CHECK (status IN ('pending', 'paid', 'expired', 'needs_review', 'picked_up')),
        total_paise   INTEGER NOT NULL CHECK (total_paise > 0),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        expires_at    TIMESTAMPTZ NOT NULL,
        paid_at       TIMESTAMPTZ,
        paid_event_id TEXT,
        picked_up_at  TIMESTAMPTZ,
        review_reason TEXT
      );
      CREATE INDEX orders_holding_idx ON orders (status, expires_at)
        WHERE status IN ('pending', 'paid');

      CREATE TABLE order_items (
        order_id         UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        product_id       INTEGER NOT NULL REFERENCES products (id),
        quantity         INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise > 0),
        PRIMARY KEY (order_id, product_id)
      );
      CREATE INDEX order_items_product_idx ON order_items (product_id);

      -- One row per provider event id: the primary key is the idempotency guard.
      CREATE TABLE payment_events (
        event_id     TEXT PRIMARY KEY,
        order_id     TEXT NOT NULL,  -- raw value from the provider; may not match an order
        amount_paise INTEGER NOT NULL,
        status       TEXT NOT NULL,
        outcome      TEXT NOT NULL,
        payload      JSONB NOT NULL,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
    `,
  },
];

const MIGRATION_LOCK_KEY = 7_272_701;

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialises concurrent migrators (e.g. the server and a test run starting together).
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    for (const migration of migrations) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
      if (applied.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
