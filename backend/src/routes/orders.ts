import express, { Router } from 'express';
import { z } from 'zod';
import { Db } from '../db/pool';
import { notFound } from '../errors';
import { claimPickup, createOrder, getOrder } from '../services/orders';

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(50),
});

export function ordersRouter(db: Db, holdSeconds: number): Router {
  const router = Router();
  router.use(express.json({ limit: '16kb' }));

  router.post('/', async (req, res) => {
    const { items } = createOrderSchema.parse(req.body);
    res.status(201).json(await createOrder(db, holdSeconds, items));
  });

  router.get('/:id', async (req, res) => {
    const order = await getOrder(db, req.params.id);
    if (!order) throw notFound('ORDER_NOT_FOUND', 'Order not found');
    res.json(order);
  });

  router.post('/:id/pickup-claim', async (req, res) => {
    res.json(await claimPickup(db, req.params.id));
  });

  return router;
}
