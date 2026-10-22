import { Client } from 'pg';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { TEST_DATABASE_URL } from './helpers';

/** Creates the test database if needed and brings its schema up to date. */
export default async function setup() {
  const target = new URL(TEST_DATABASE_URL);
  const dbName = target.pathname.slice(1);
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL at ${admin.host}. Start it with "docker compose up -d db" ` +
        `or set TEST_DATABASE_URL. (${(err as Error).message})`,
    );
  }
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  await client.end();

  const pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.end();
}
