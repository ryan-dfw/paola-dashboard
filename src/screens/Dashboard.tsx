import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Me, Order } from '../../shared/types';
import { Brand } from '../components/Brand';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { OrderDetail } from '../components/OrderDetail';
import { OrderRow, type RowAction } from '../components/OrderRow';
import { Toast, type ToastMsg } from '../components/Toast';
import { useAuth } from '../hooks/useAuth';
import type { Route } from '../hooks/useHashRoute';
import { useOrders } from '../hooks/useOrders';
import { ApiError } from '../lib/api';
import { applyFilters, FILTERS, inView, queueSections, search, type FilterKey, type View } from '../lib/orderView';
import { Setup } from './Setup';

const VIEW_LABEL: Record<View, string> = { needs_action: 'To do', completed: 'Completed', all: 'All orders' };

function loadView(): View {
  try {
    const v = sessionStorage.getItem('view');
    if (v === 'needs_action' || v === 'completed' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'needs_action';
}

interface Props {
  me: Me;
  route: Route;
  go(r: Route): void;
  back(): void;
}

export function Dashboard({ me, route, go, back }: Props) {
  const { signOut } = useAuth();
  const data = useOrders();
  const [view, setViewState] = useState<View>(loadView);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Set<FilterKey>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [startShipping, setStartShipping] = useState<string | null>(null);
  const [detailMissing, setDetailMissing] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const setView = (v: View) => {
    setViewState(v);
    setSelecting(false);
    setSelected(new Set());
    try {
      sessionStorage.setItem('view', v);
    } catch {
      /* ignore */
    }
    window.scrollTo({ top: 0 });
  };

  const notify = useCallback((text: string, opts: { kind?: 'ok' | 'error'; undo?: () => void } = {}) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, kind: opts.kind, action: opts.undo ? { label: 'Undo', run: opts.undo } : undefined });
    toastTimer.current = window.setTimeout(() => setToast(null), opts.undo ? 7000 : 4000);
  }, []);

  const todoCount = useMemo(() => data.orders.filter((o) => o.bucket === 'needs_action').length, [data.orders]);
  const filtered = useMemo(() => search(applyFilters(inView(data.orders, view), filters), query), [data.orders, view, filters, query]);
  const elsewhere = useMemo(
    () => (query || filters.size ? search(applyFilters(inView(data.orders, 'all'), filters), query).length : 0),
    [data.orders, filters, query],
  );
  const legacyPickups = useMemo(
    () => data.orders.filter((o) => o.stage === 'waiting_for_pickup' && o.fulfillment.noStatusRecorded),
    [data.orders],
  );

  // ---------- order detail ----------
  const openId = route.name === 'order' ? route.id : null;
  const openOrder = openId ? (data.orders.find((o) => o.id === openId) ?? null) : null;
  useEffect(() => {
    // Deep link to an order that isn't in the loaded list (yet) — fetch it directly.
    if (!openId || openOrder || data.loadingMore || data.status !== 'ready') return;
    let cancelled = false;
    data.refreshOne(openId).catch((err) => {
      if (!cancelled) setDetailMissing(err instanceof ApiError ? err.message : 'Could not load this order.');
    });
    return () => {
      cancelled = true;
    };
  }, [openId, openOrder, data.loadingMore, data.status, data.refreshOne]);

  useEffect(() => {
    document.body.classList.toggle('detail-open', Boolean(openId));
    return () => document.body.classList.remove('detail-open');
  }, [openId]);

  const open = (id: string) => {
    setStartShipping(null);
    setDetailMissing(null);
    go({ name: 'order', id });
  };

  const expect = (o: Order) => ({
    expectedStatus: o.fulfillment.status,
    expectedMethod: o.fulfillment.method,
    expectedShippingPayment: o.shippingPayment.status,
  });

  /** One-tap actions on a row. Each offers Undo in the toast. */
  const onRowAction = async (o: Order, a: RowAction) => {
    if (a === 'ship') {
      setStartShipping(o.id);
      go({ name: 'order', id: o.id });
      return;
    }
    const name = o.customer.name || 'This order';
    const [req, undo, done] =
      a === 'picked_up'
        ? ([{ action: 'mark_picked_up' }, { action: 'mark_waiting' }, `${name} marked as picked up`] as const)
        : ([{ action: 'mark_shipping_paid' }, { action: 'mark_shipping_unpaid' }, `Shipping paid — ${name} is ready to ship`] as const);
    setRowBusy(o.id);
    try {
      const updated = await data.act(o.id, { ...req, ...expect(o) });
      notify(done, {
        undo: () => void data.act(o.id, { ...undo, ...expect(updated) }).catch(() => notify('Could not undo.', { kind: 'error' })),
      });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save. Try again.', { kind: 'error' });
    } finally {
      setRowBusy(null);
    }
  };

  // ---------- bulk pickup ----------
  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const startSelecting = (preselect: Order[] = []) => {
    if (view !== 'needs_action') setView('needs_action');
    setSelecting(true);
    setSelected(new Set(preselect.map((o) => o.id)));
  };

  const runBulk = async () => {
    const ids = [...selected];
    setBulkProgress({ done: 0, total: ids.length });
    let ok = 0;
    const failed: string[] = [];
    for (const id of ids) {
      const o = data.orders.find((x) => x.id === id);
      try {
        await data.act(id, { action: 'mark_picked_up', ...(o ? expect(o) : {}) });
        ok += 1;
      } catch {
        failed.push(o?.customer.name || id);
      }
      setBulkProgress({ done: ok + failed.length, total: ids.length });
    }
    setBulkProgress(null);
    setBulkConfirm(false);
    setSelecting(false);
    setSelected(new Set());
    notify(failed.length ? `Marked ${ok} picked up. ${failed.length} failed: ${failed.join(', ')}` : `Marked ${ok} picked up`, {
      kind: failed.length ? 'error' : 'ok',
    });
  };

  // ---------- rendering helpers ----------
  const rows = (list: Order[], context: 'queue' | 'flat') =>
    list.map((o) => (
      <OrderRow
        key={o.id}
        order={o}
        context={context}
        onOpen={open}
        onAction={onRowAction}
        busy={rowBusy === o.id}
        selectable={selecting && o.stage === 'waiting_for_pickup'}
        selected={selected.has(o.id)}
        onToggleSelect={toggleSelect}
        isOpen={o.id === openId}
      />
    ));

  const errorText = (e: ApiError | null) => {
    if (!e) return '';
    if (e.code === 'network') return 'Can’t reach the server. Check your internet connection.';
    if (e.code === 'stripe_unavailable') return 'Can’t reach the payment system (Stripe) right now. Your orders are safe — try again in a minute.';
    if (e.code.startsWith('stripe_')) return `The payment system (Stripe) refused the request. Ask Ryan to check the setup. (${e.message})`;
    if (e.code === 'config_missing') return `The dashboard isn’t fully set up: ${e.message}`;
    return e.message;
  };

  let content;
  if (route.name === 'setup' && me.role === 'superadmin') {
    content = <Setup orders={data.orders} onOpen={open} />;
  } else if (data.status === 'loading') {
    content = (
      <div className="state-box" aria-busy="true" data-testid="loading">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
        <p className="muted">Loading orders…</p>
      </div>
    );
  } else if (data.status === 'error') {
    content = (
      <div className="state-box state-error" role="alert" data-testid="load-error">
        <Icon name="alert" size={28} />
        <h2>Couldn’t load orders</h2>
        <p>{errorText(data.error)}</p>
        <button className="btn btn-primary" onClick={() => void data.reload()}>
          Try again
        </button>
      </div>
    );
  } else if (data.orders.length === 0) {
    content = (
      <div className="state-box" data-testid="no-orders">
        <h2>No orders yet</h2>
        <p className="muted">When someone buys a book, it shows up here.</p>
      </div>
    );
  } else {
    const isNeeds = view === 'needs_action' && !query && !filters.size;
    const sections = isNeeds ? queueSections(filtered) : [];
    content = (
      <>
        {view === 'needs_action' && legacyPickups.length > 1 && !selecting && (
          <div className="legacy-banner" data-testid="legacy-banner">
            <p>
              <strong>{legacyPickups.length} pickups</strong> are from before this dashboard. Already handed them over at the launch event?
            </p>
            <button className="btn btn-secondary" onClick={() => startSelecting(legacyPickups)}>
              Review &amp; mark picked up
            </button>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="state-box" data-testid="empty-view">
            {view === 'needs_action' && !query && !filters.size ? (
              <>
                <Icon name="check" size={28} />
                <h2>All caught up</h2>
                <p className="muted">Nothing needs doing right now. Finished orders are under Completed.</p>
              </>
            ) : (
              <>
                <h2>No matches</h2>
                {elsewhere > 0 && view !== 'all' ? (
                  <button className="link-btn" onClick={() => setView('all')}>
                    {elsewhere} {elsewhere === 1 ? 'match' : 'matches'} in All orders — show
                  </button>
                ) : (
                  <p className="muted">Try a different search or clear the filters.</p>
                )}
              </>
            )}
          </div>
        ) : isNeeds ? (
          <>
            {sections.length > 1 && filtered.length > 6 && (
              <nav className="jump" aria-label="Jump to">
                {sections.map((sec) => (
                  <a key={sec.stage} href={`#group-${sec.stage}`} className={`jump-${sec.stage}`} onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`group-${sec.stage}`)?.scrollIntoView({ behavior: 'smooth' });
                  }}>
                    {sec.orders.length} {sec.stage === 'problem' && sec.orders.length === 1 ? 'problem' : sec.title.toLowerCase()}
                  </a>
                ))}
              </nav>
            )}
            {sections.map((sec) => (
              <section key={sec.stage} className={`group group-${sec.stage}`} id={`group-${sec.stage}`} aria-labelledby={`h-${sec.stage}`}>
                <div className="group-head">
                  <h2 id={`h-${sec.stage}`}>
                    {sec.title} <span className="count">{sec.orders.length}</span>
                  </h2>
                  <span className="group-hint">{sec.hint}</span>
                  {sec.stage === 'waiting_for_pickup' && sec.orders.length > 1 && !selecting && (
                    <button className="link-btn" onClick={() => startSelecting()}>
                      Select several
                    </button>
                  )}
                </div>
                <div className="order-list">{rows(sec.orders, 'queue')}</div>
              </section>
            ))}
          </>
        ) : (
          <div className="order-list">{rows(filtered, 'flat')}</div>
        )}

        {data.loadingMore && <p className="muted center small">Loading older orders…</p>}
      </>
    );
  }

  const activeFilterCount = filters.size;

  return (
    <div className={`app${openId ? ' has-detail' : ''}`}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-brand">
            <Brand />
            <h1 className="page-title">{route.name === 'setup' ? 'Setup' : 'Orders'}</h1>
          </div>
          <div className="topbar-actions">
            {route.name === 'setup' ? (
              <button className="btn btn-quiet btn-small" onClick={() => go({ name: 'list' })}>
                <Icon name="back" size={16} /> Orders
              </button>
            ) : (
              <button
                className={`icon-btn${data.loadingMore ? ' spinning' : ''}`}
                onClick={() => void data.reload()}
                aria-label="Refresh orders"
                title="Refresh"
                disabled={data.loadingMore}
              >
                <Icon name="refresh" size={20} />
              </button>
            )}
            <div className="menu-wrap">
              <button className="icon-btn" aria-label="Account" aria-expanded={menuOpen} onClick={() => setMenuOpen((m) => !m)}>
                <Icon name="user" size={20} />
              </button>
              {menuOpen && (
                <div className="menu" role="menu" onClick={() => setMenuOpen(false)}>
                  <p className="menu-who">
                    {me.email}
                    {me.role === 'superadmin' && <span className="role-tag">superadmin</span>}
                  </p>
                  {me.role === 'superadmin' && (
                    <button role="menuitem" onClick={() => go({ name: 'setup' })}>
                      <Icon name="gear" size={16} /> Setup &amp; data audit
                    </button>
                  )}
                  <button role="menuitem" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="main">
        {route.name !== 'setup' && data.status === 'ready' && data.orders.length > 0 && (
          <>
            <div className="tabs" role="tablist">
              {(['needs_action', 'completed', 'all'] as View[]).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  className={`tab${view === v ? ' is-active' : ''}`}
                  onClick={() => setView(v)}
                >
                  {VIEW_LABEL[v]}
                  {v === 'needs_action' && todoCount > 0 && <span className="count">{todoCount}</span>}
                </button>
              ))}
            </div>

            <div className="toolbar">
              <label className="search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  placeholder="Search name, email, book, order ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search orders"
                  autoCorrect="off"
                  autoCapitalize="none"
                />
              </label>
              <button
                className={`btn btn-quiet filter-toggle${activeFilterCount ? ' has-active' : ''}`}
                aria-expanded={showFilters}
                onClick={() => setShowFilters((s) => !s)}
              >
                Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
              </button>
            </div>
            {(showFilters || activeFilterCount > 0) && (
              <div className="chips" role="group" aria-label="Filters">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    className={`chip${filters.has(f.key) ? ' is-on' : ''}`}
                    aria-pressed={filters.has(f.key)}
                    onClick={() =>
                      setFilters((s) => {
                        const n = new Set(s);
                        if (n.has(f.key)) n.delete(f.key);
                        else n.add(f.key);
                        return n;
                      })
                    }
                  >
                    {f.label}
                  </button>
                ))}
                {activeFilterCount > 0 && (
                  <button className="chip chip-clear" onClick={() => setFilters(new Set())}>
                    Clear
                  </button>
                )}
              </div>
            )}

            {data.partial && data.error && (
              <p className="inline-warning" role="alert">
                Some older orders couldn’t be loaded ({errorText(data.error)}).{' '}
                <button className="link-btn" onClick={() => void data.reload()}>
                  Retry
                </button>
              </p>
            )}
          </>
        )}

        {content}
      </main>

      {openId && (
        <>
          <div className="detail-scrim" onClick={back} aria-hidden="true" />
          <aside className="detail-panel">
            {openOrder ? (
              <OrderDetail
                key={openOrder.id}
                order={openOrder}
                startShipping={startShipping === openOrder.id}
                onClose={back}
                act={data.act}
                notify={notify}
              />
            ) : (
              <div className="detail">
                <header className="detail-head">
                  <button className="icon-btn detail-back" onClick={back} aria-label="Back to orders">
                    <Icon name="back" size={22} />
                  </button>
                </header>
                <div className="state-box">
                  {detailMissing ? <p role="alert">{detailMissing}</p> : <p className="muted">Loading order…</p>}
                </div>
              </div>
            )}
          </aside>
        </>
      )}

      {selecting && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span>{selected.size} selected</span>
          <button
            className="btn btn-quiet"
            onClick={() => {
              setSelecting(false);
              setSelected(new Set());
            }}
          >
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!selected.size} onClick={() => setBulkConfirm(true)}>
            <Icon name="check" size={16} /> Mark {selected.size} picked up
          </button>
        </div>
      )}

      {bulkConfirm && (
        <ConfirmDialog
          title={`Mark ${selected.size} orders picked up?`}
          body={
            bulkProgress
              ? `Saving ${bulkProgress.done} of ${bulkProgress.total}…`
              : 'Only do this if these books have already been handed over. You can undo any of them individually later.'
          }
          confirmLabel={`Mark ${selected.size} picked up`}
          busy={Boolean(bulkProgress)}
          onCancel={() => setBulkConfirm(false)}
          onConfirm={() => void runBulk()}
        />
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
