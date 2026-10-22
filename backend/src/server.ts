import { createApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';
import { seedIfEmpty } from './db/seed';
import { expireLapsedOrders } from './services/orders';

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);

  await migrate(db);
  await seedIfEmpty(db);

  const app = createApp({ db, webhookSecret: config.webhookSecret, holdSeconds: config.holdSeconds });
  const server = app.listen(config.port, () => {
    console.log(`Pickup counter API listening on :${config.port} (hold ${config.holdSeconds}s)`);
  });

  // Bookkeeping only: availability already ignores lapsed holds without it.
  const sweeper = setInterval(() => {
    expireLapsedOrders(db).catch((err) => console.error('expiry sweep failed', err));
  }, config.sweepIntervalMs);

  const shutdown = () => {
    clearInterval(sweeper);
    server.close(() => void db.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
