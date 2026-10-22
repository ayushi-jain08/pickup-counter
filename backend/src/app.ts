import express, { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { Db } from './db/pool';
import { HttpError } from './errors';
import { ordersRouter } from './routes/orders';
import { paymentsRouter } from './routes/payments';
import { productsRouter } from './routes/products';

export interface AppDeps {
  db: Db;
  webhookSecret: string;
  holdSeconds: number;
}

export function createApp({ db, webhookSecret, holdSeconds }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/products', productsRouter(db));
  app.use('/orders', ordersRouter(db, holdSeconds));
  app.use('/payments', paymentsRouter(db, webhookSecret));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request', details: err.issues } });
    return;
  }
  // Body-parser errors (malformed JSON, payload too large) carry their own status.
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};
