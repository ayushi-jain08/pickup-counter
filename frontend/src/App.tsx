import { useState } from 'react';
import { Order, Timed } from './api';
import { Payment } from './Payment';
import { Shop } from './Shop';

export function App() {
  const [placed, setPlaced] = useState<Timed<Order> | null>(null);

  return (
    <main>
      <h1>Pickup Counter</h1>
      {placed ? <Payment key={placed.data.id} initial={placed} onDone={() => setPlaced(null)} /> : <Shop onOrderPlaced={setPlaced} />}
    </main>
  );
}
