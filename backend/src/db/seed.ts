import { Pool } from 'pg';

const SEED_PRODUCTS = [
  { name: 'Samosa', pricePaise: 2000, stock: 10 },
  { name: 'Masala Chips', pricePaise: 3000, stock: 8 },
  { name: 'Chocolate Bar', pricePaise: 4500, stock: 5 },
  { name: 'Cold Coffee', pricePaise: 6000, stock: 6 },
  { name: 'Peanut Chikki', pricePaise: 1500, stock: 2 },
];

/** Seeds the catalogue on first start only, so restarts never reset stock. */
export async function seedIfEmpty(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM products');
  if (rows[0].count > 0) return;
  for (const p of SEED_PRODUCTS) {
    await pool.query(
      'INSERT INTO products (name, price_paise, stock) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
      [p.name, p.pricePaise, p.stock],
    );
  }
}
