import { useEffect, useState } from 'react';
import { Order, Timed, fetchOrder } from './api';
import { formatPaise } from './money';
import { formatCountdown, useServerCountdown } from './useServerCountdown';

const POLL_MS = 2000;
const isFinal = (status: Order['status']) => status !== 'pending';

export function Payment({ initial, onDone }: { initial: Timed<Order>; onDone: () => void }) {
  const [order, setOrder] = useState(initial.data);
  const [connectionLost, setConnectionLost] = useState(false);
  const { remainingMs, sync } = useServerCountdown();

  useEffect(() => sync(initial.data.expiresInSeconds, initial.sentAt), [initial, sync]);

  const timeUp = remainingMs === 0;

  // Poll until the server reports a final status. When our countdown hits zero we
  // poll at once, but the server's answer is what decides "expired", not our timer.
  useEffect(() => {
    if (isFinal(order.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetchOrder(order.id);
        if (cancelled) return;
        setConnectionLost(false);
        setOrder(res.data);
        if (res.data.status === 'pending') sync(res.data.expiresInSeconds, res.sentAt);
      } catch {
        if (!cancelled) setConnectionLost(true);
      }
    };
    if (timeUp) void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [order.id, order.status, timeUp, sync]);

  return (
    <div className="payment">
      <OrderSummary order={order} />
      {order.status === 'pending' && (
        <>
          <p className="countdown" aria-live="polite">
            {timeUp ? 'Checking payment…' : formatCountdown(remainingMs ?? 0)}
          </p>
          <p>Scan the UPI code on the counter and pay <strong>{formatPaise(order.totalPaise)}</strong>.</p>
          <p className="muted">Your items are reserved until the timer runs out.</p>
          <details className="dev">
            <summary>Simulate the payment provider (for testing)</summary>
            <code>npm run send-webhook -- {order.id}</code>
          </details>
        </>
      )}
      {order.status === 'paid' && (
        <Message kind="ok" title="Payment received!">
          Collect your order from the locker. Your order code is <code>{shortId(order.id)}</code>.
        </Message>
      )}
      {order.status === 'picked_up' && <Message kind="ok" title="Collected">Enjoy your snacks!</Message>}
      {order.status === 'expired' && (
        <Message kind="warn" title="Time ran out">
          We didn't receive your payment in time, so the items were released. If money left your account
          after this, it will be honoured if the items are still in stock, otherwise staff will refund it.
        </Message>
      )}
      {order.status === 'needs_review' && (
        <Message kind="warn" title="Payment needs a quick check">
          We received a payment that we couldn't match to this order automatically
          {order.reviewReason === 'amount_mismatch' ? ' (the amount was different)' : ''}. Please show
          order code <code>{shortId(order.id)}</code> to a staff member.
        </Message>
      )}
      {connectionLost && <p className="error">Connection problem, still trying…</p>}
      {isFinal(order.status) && (
        <button className="primary" onClick={onDone}>
          Start a new order
        </button>
      )}
    </div>
  );
}

function OrderSummary({ order }: { order: Order }) {
  return (
    <ul className="summary">
      {order.items.map((i) => (
        <li key={i.productId}>
          {i.quantity} × {i.name} <span>{formatPaise(i.unitPricePaise * i.quantity)}</span>
        </li>
      ))}
      <li className="total">
        Total <span>{formatPaise(order.totalPaise)}</span>
      </li>
    </ul>
  );
}

function Message({ kind, title, children }: { kind: 'ok' | 'warn'; title: string; children: React.ReactNode }) {
  return (
    <div className={`message ${kind}`} role="status">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

const shortId = (id: string) => id.slice(0, 8).toUpperCase();
