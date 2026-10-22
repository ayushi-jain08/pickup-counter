import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant-time check of a hex HMAC-SHA256 signature over the exact raw bytes. */
export function isValidSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const provided = header.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) return false;
  const expected = Buffer.from(signPayload(secret, rawBody), 'hex');
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}
