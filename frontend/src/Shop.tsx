import { useCallback, useEffect, useState } from 'react';
import { ApiError, Order, Product, Timed, fetchProducts, placeOrder } from './api';
import { formatPaise } from './money';

type Cart = Record<number, number>;

export function Shop({ onOrderPlaced }: { onOrderPlaced: (order: Timed<Order>) => void }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProducts(await fetchProducts());
    } catch {
      setError('Could not load products. Retrying…');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const change = (product: Product, delta: number) => {
    setCart((c) => {
      const next = Math.min(product.availableUnits, Math.max(0, (c[product.id] ?? 0) + delta));
      const { [product.id]: _, ...rest } = c;
      return next === 0 ? rest : { ...rest, [product.id]: next };
    });
  };

  const lines = (products ?? []).filter((p) => cart[p.id]).map((p) => ({ product: p, quantity: cart[p.id] }));
  const total = lines.reduce((sum, l) => sum + l.product.pricePaise * l.quantity, 0);

  const submit = async () => {
    setPlacing(true);
    setError(null);
    try {
      const order = await placeOrder(lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })));
      setCart({});
      onOrderPlaced(order);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK'
          ? 'Sorry, someone just took some of those items. Your cart has been checked against current stock.'
          : 'Could not place the order. Please try again.',
      );
      await refresh();
    } finally {
      setPlacing(false);
    }
  };

  if (!products) return <p>{error ?? 'Loading products…'}</p>;

  return (
    <div className="shop">
      <section>
        <h2>Snacks</h2>
        <ul className="products">
          {products.map((p) => {
            const inCart = cart[p.id] ?? 0;
            return (
              <li key={p.id} className={p.availableUnits === 0 ? 'sold-out' : ''}>
                <div>
                  <strong>{p.name}</strong>
                  <div className="muted">
                    {formatPaise(p.pricePaise)} · {p.availableUnits === 0 ? 'Sold out' : `${p.availableUnits} available`}
                  </div>
                </div>
                <div className="stepper">
                  <button onClick={() => change(p, -1)} disabled={inCart === 0} aria-label={`Remove ${p.name}`}>−</button>
                  <span>{inCart}</span>
                  <button onClick={() => change(p, 1)} disabled={inCart >= p.availableUnits} aria-label={`Add ${p.name}`}>+</button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="cart">
        <h2>Your order</h2>
        {lines.length === 0 ? (
          <p className="muted">Add something to get started.</p>
        ) : (
          <ul>
            {lines.map((l) => (
              <li key={l.product.id}>
                {l.quantity} × {l.product.name} <span>{formatPaise(l.product.pricePaise * l.quantity)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="total">Total: {formatPaise(total)}</p>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={lines.length === 0 || placing} onClick={submit}>
          {placing ? 'Placing order…' : 'Place order & pay by UPI'}
        </button>
      </section>
    </div>
  );
}
