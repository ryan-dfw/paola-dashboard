// Superadmin-only. The server enforces this (every /api/admin/* call checks
// the superadmin role); the UI just doesn't link to it for anyone else.

import { useCallback, useEffect, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import type { AdminStatus, Order } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { getFirebaseAuth } from '../lib/firebase';
import { editionLine, money, shortDate, stageLabel } from '../lib/format';

export function Setup({ orders, onOpen }: { orders: Order[]; onOpen(id: string): void }) {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api.adminStatus());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load setup status.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createAccount = async (email: string) => {
    setBusy(email);
    setMsg(null);
    try {
      const r = await api.adminAccount({ action: 'create', email });
      await sendPasswordResetEmail(getFirebaseAuth(), email);
      setMsg(`${r.message} A “set your password” email was sent to ${email}.`);
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyAudit = async () => {
    const rows = orders.map((o) => ({
      id: o.id,
      created: o.createdAt,
      customer: o.customer.name,
      items: o.items.map((i) => `${i.quantity}x ${i.productName ?? i.description} [${i.kind} ${i.language ?? '?'} ${i.format ?? '?'}]`),
      checkoutChoice: o.checkout.choice,
      checkoutChoiceSource: o.checkout.choiceSource,
      currentMethod: o.fulfillment.method,
      fulfillmentStatus: o.fulfillment.status,
      shippingPayment: `${o.shippingPayment.status} (${o.shippingPayment.source})`,
      signals: o.checkout.signals,
      stage: o.stage,
      issues: o.issues.map((i) => `${i.severity}:${i.code}`),
      amounts: o.amounts,
    }));
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    setMsg('Audit JSON copied.');
  };

  const counts = orders.reduce<Record<string, number>>((acc, o) => {
    const k = `ordered as ${o.checkout.choice} (${o.checkout.choiceSource})`;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="setup" data-testid="setup">
      {error && (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
      {msg && (
        <p className="inline-info" role="status">
          {msg}
        </p>
      )}

      <section className="card-section">
        <h3>Stripe</h3>
        {status ? (
          <p className={status.stripe.ok ? 'text-ok' : 'text-problem'}>
            {status.stripe.ok ? '✓' : '✗'} {status.stripe.detail}{' '}
            <span className="muted">
              ({status.stripe.mode} mode, {status.stripe.keyType} key)
            </span>
          </p>
        ) : (
          <p className="muted">Checking…</p>
        )}
      </section>

      <section className="card-section">
        <h3>Environment (server)</h3>
        <table className="mini-table">
          <tbody>
            {status?.env.map((e) => (
              <tr key={e.name}>
                <td>
                  <code>{e.name}</code>
                </td>
                <td className={e.present ? 'text-ok' : 'muted'}>{e.present ? 'set' : 'not set'}</td>
                <td className="muted small">{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Values are never sent to the browser — only whether each one is set.</p>
      </section>

      <section className="card-section">
        <h3>Who can sign in</h3>
        <p className="muted small">
          From <code>DASHBOARD_USERS</code> / <code>DASHBOARD_SUPERADMINS</code>..
          Firebase project: {status?.firebase.projectId ?? '…'}
          {status?.allowlist.some((a) => !a.account.checked) && ' — Admin credentials not set, so account details can’t be checked here.'}
        </p>
        <table className="mini-table">
          <tbody>
            {status?.allowlist.map((a) => (
              <tr key={a.value}>
                <td>
                  {a.value} <span className="muted small">({a.kind})</span>
                </td>
                <td>{a.role === 'superadmin' ? <span className="role-tag">superadmin</span> : 'user'}</td>
                <td className="small">
                  {!a.account.checked && <span className="muted">{a.account.reason}</span>}
                  {a.account.checked && !a.account.exists && <span className="text-problem">No account yet</span>}
                  {a.account.checked && a.account.exists && (
                    <span>
                      {a.account.disabled ? <span className="text-problem">disabled · </span> : null}
                      <span className="text-ok">account exists</span>
                      {' · '}
                      {a.account.lastSignIn ? `last sign-in ${shortDate(a.account.lastSignIn)}` : 'never signed in'}
                    </span>
                  )}
                </td>
                <td>
                  {a.kind === 'email' && a.account.checked && !a.account.exists && (
                    <button
                      className="btn btn-secondary btn-small"
                      disabled={busy === a.value}
                      onClick={() => void createAccount(a.value)}
                    >
                      Create &amp; email setup link
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card-section">
        <h3>Data audit — how every order was classified</h3>
        <p className="muted small">
          {Object.entries(counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(' · ') || 'No orders loaded.'}{' '}
          <button className="link-btn" onClick={() => void copyAudit()}>
            Copy as JSON
          </button>
        </p>
        <div className="audit-wrap">
          <table className="audit">
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Book</th>
                <th>Ordered as (why)</th>
                <th>Stage</th>
                <th>Total</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} onClick={() => onOpen(o.id)}>
                  <td>{shortDate(o.createdAt)}</td>
                  <td>{o.customer.name}</td>
                  <td>{editionLine(o)}</td>
                  <td>
                    {o.checkout.choice} <span className="muted small">({o.checkout.choiceSource})</span>
                    {o.fulfillment.changedFromCheckout && <span className="small block">now {o.fulfillment.method}</span>}
                  </td>
                  <td>{stageLabel(o)}</td>
                  <td>{money(o.amounts.total, o.amounts.currency)}</td>
                  <td className="small">{o.issues.map((i) => `${i.severity === 'problem' ? '⚠ ' : ''}${i.code}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
