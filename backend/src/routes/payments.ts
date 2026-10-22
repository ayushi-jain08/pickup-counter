import express, { Router } from 'express';
import { Db } from '../db/pool';
import { HttpError, badRequest } from '../errors';
import { processWebhook, webhookEventSchema } from '../services/payments';
import { isValidSignature } from '../signature';

export function paymentsRouter(db: Db, webhookSecret: string): Router {
  const router = Router();

  // Keep the body as raw bytes: the signature covers the exact bytes sent,
  // and re-serialising parsed JSON would not reproduce them.
  router.post('/webhook', express.raw({ type: () => true, limit: '16kb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(webhookSecret, rawBody, req.get('X-Signature'))) {
      throw new HttpError(401, 'INVALID_SIGNATURE', 'Signature does not match');
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw badRequest('INVALID_JSON', 'Body is not valid JSON');
    }

    res.json(await processWebhook(db, webhookEventSchema.parse(json)));
  });

  return router;
}
