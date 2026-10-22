import { Router } from 'express';
import { Db } from '../db/pool';
import { listProducts } from '../services/stock';

export function productsRouter(db: Db): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ products: await listProducts(db) });
  });

  return router;
}
