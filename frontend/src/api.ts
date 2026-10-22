export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_review' | 'picked_up';

export interface Product {
  id: number;
  name: string;
  pricePaise: number;
  availableUnits: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  items: { productId: number; name: string; quantity: number; unitPricePaise: number }[];
  expiresInSeconds: number;
  reviewReason: string | null;
}

/**
 * A response plus the monotonic time the request was *sent*. The server measured
 * expiresInSeconds at some point after that, so anchoring the countdown here can
 * only make it end slightly early, never late.
 */
export interface Timed<T> {
  data: T;
  sentAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<Timed<T>> {
  const sentAt = performance.now();
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? `HTTP ${res.status}`);
  }
  return { data: json as T, sentAt };
}

export const fetchProducts = async () => (await request<{ products: Product[] }>('GET', '/products')).data.products;

export const placeOrder = (items: { productId: number; quantity: number }[]) =>
  request<Order>('POST', '/orders', { items });

export const fetchOrder = (id: string) => request<Order>('GET', `/orders/${id}`);
