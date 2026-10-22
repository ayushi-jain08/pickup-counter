/**
 * Sends a correctly signed payment webhook, acting as the UPI provider.
 *
 *   npm run send-webhook -- <orderId> [--amount <paise>] [--event <eventId>]
 *                                     [--status captured|failed] [--bad-signature]
 *
 * Without --amount it looks up the order and pays its exact total.
 * Re-use an --event id to simulate the provider redelivering the same event.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signPayload } from '../src/signature';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const SECRET = process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      amount: { type: 'string' },
      event: { type: 'string' },
      status: { type: 'string', default: 'captured' },
      'bad-signature': { type: 'boolean', default: false },
    },
  });

  const orderId = positionals[0];
  if (!orderId) {
    console.error('Usage: npm run send-webhook -- <orderId> [--amount <paise>] [--event <id>] [--status captured|failed]');
    process.exit(2);
  }

  let amountPaise: number;
  if (values.amount !== undefined) {
    amountPaise = Number(values.amount);
  } else {
    const res = await fetch(`${API_URL}/orders/${orderId}`);
    if (!res.ok) throw new Error(`Could not look up order ${orderId}: HTTP ${res.status} ${await res.text()}`);
    amountPaise = ((await res.json()) as { totalPaise: number }).totalPaise;
  }

  const body = JSON.stringify({
    eventId: values.event ?? `evt_${randomUUID()}`,
    orderId,
    amountPaise,
    status: values.status,
  });
  const signature = values['bad-signature'] ? '0'.repeat(64) : signPayload(SECRET, body);

  const res = await fetch(`${API_URL}/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
    body,
  });
  console.log(`-> POST ${API_URL}/payments/webhook`);
  console.log(`   ${body}`);
  console.log(`<- HTTP ${res.status}`);
  console.log(`   ${await res.text()}`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
