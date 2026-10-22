import { Pool, PoolClient } from 'pg';

export type Db = Pool;
export type Tx = PoolClient;

export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({ connectionString, max });
}

/**
 * Runs `fn` inside a READ COMMITTED transaction. Correctness under concurrency
 * comes from explicit row locks (SELECT ... FOR UPDATE / UPDATE ... WHERE),
 * not from the isolation level, so callers must take the locks they need.
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
