import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A countdown that never reads the wall clock.
 *
 * The kiosk's clock may be minutes off, so Date.now() and the server's
 * expiresAt timestamp are useless together. Instead we only use durations:
 * the server says "N seconds left" and we count down on performance.now(),
 * a monotonic clock that is unaffected by the wall-clock setting (or by
 * someone changing it mid-countdown).
 *
 * Each sync gives a lower bound on the true deadline (anchored at request send
 * time, and the server floors to whole seconds), so we keep the latest of them:
 * more polls make it more accurate, and it can only ever end early, not late.
 */
export function useServerCountdown() {
  const deadline = useRef<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const sync = useCallback((expiresInSeconds: number, sentAt: number) => {
    const candidate = sentAt + expiresInSeconds * 1000;
    deadline.current = deadline.current === null ? candidate : Math.max(deadline.current, candidate);
    setRemainingMs(Math.max(0, deadline.current - performance.now()));
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (deadline.current !== null) setRemainingMs(Math.max(0, deadline.current - performance.now()));
    }, 200);
    return () => clearInterval(id);
  }, []);

  return { remainingMs, sync };
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
