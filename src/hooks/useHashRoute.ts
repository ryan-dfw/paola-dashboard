import { useCallback, useEffect, useState } from 'react';

export type Route = { name: 'list' } | { name: 'order'; id: string } | { name: 'setup' };

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const m = /^order\/([A-Za-z0-9_]+)$/.exec(h);
  if (m) return { name: 'order', id: m[1] };
  if (h === 'setup') return { name: 'setup' };
  return { name: 'list' };
}

/** Tiny hash router so the iPhone back gesture / browser back closes an order. */
export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((r: Route) => {
    const next = r.name === 'order' ? `#/order/${r.id}` : r.name === 'setup' ? '#/setup' : '#/';
    if (window.location.hash !== next) window.location.hash = next;
  }, []);
  const back = useCallback(() => {
    if (window.history.length > 1 && window.location.hash.startsWith('#/order/')) window.history.back();
    else window.location.hash = '#/';
  }, []);
  return { route, go, back };
}
