import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Address, AddressInput, FulfillmentRequest, Order } from '../../shared/types';
import { ApiError } from '../lib/api';
import {
  checks,
  customerEmailLink,
  dateTime,
  editionLine,
  FORMAT_LABEL,
  LANGUAGE_LABEL,
  METHOD_LABEL,
  money,
  stripeDashboardUrl,
  trackingUrl,
} from '../lib/format';
import { AddressBlock } from './Address';
import { RowBadges, StageBadge } from './Badges';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';

const CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'Other'];

interface Props {
  order: Order;
  startShipping?: boolean;
  onClose(): void;
  act(id: string, req: FulfillmentRequest): Promise<Order>;
  notify(text: string, opts?: { kind?: 'ok' | 'error'; undo?: () => void }): void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ShipForm({
  initialCarrier,
  initialTracking,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initialCarrier?: string | null;
  initialTracking?: string | null;
  submitLabel: string;
  busy: boolean;
  onSubmit(carrier: string, tracking: string): void;
  onCancel(): void;
}) {
  const known = CARRIERS.includes(initialCarrier || '') ? initialCarrier! : initialCarrier ? 'Other' : 'USPS';
  const [carrier, setCarrier] = useState(known);
  const [other, setOther] = useState(known === 'Other' ? initialCarrier || '' : '');
  const [tracking, setTracking] = useState(initialTracking || '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(carrier === 'Other' ? other.trim() : carrier, tracking.trim());
  };
  return (
    <form className="ship-form" onSubmit={submit}>
      <label className="field">
        <span>Carrier (optional)</span>
        <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
          {CARRIERS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      {carrier === 'Other' && (
        <label className="field">
          <span>Carrier name</span>
          <input value={other} onChange={(e) => setOther(e.target.value)} maxLength={60} />
        </label>
      )}
      <label className="field">
        <span>Tracking number (optional)</span>
        <input
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          maxLength={100}
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="e.g. 9400 1000 0000 0000 0000 00"
        />
      </label>
      <div className="ship-form-actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-big" disabled={busy}>
          <Icon name="truck" /> {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function AddressForm({
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: Address | null;
  busy: boolean;
  onSubmit(a: AddressInput): void;
  onCancel(): void;
}) {
  const [a, setA] = useState<AddressInput>({
    name: initial?.name ?? '',
    line1: initial?.line1 ?? '',
    line2: initial?.line2 ?? '',
    city: initial?.city ?? '',
    state: initial?.state ?? '',
    postalCode: initial?.postalCode ?? '',
  });
  const field = (k: keyof AddressInput, label: string, props: Record<string, unknown> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={a[k] ?? ''} onChange={(e) => setA({ ...a, [k]: e.target.value })} maxLength={100} {...props} />
    </label>
  );
  return (
    <form
      className="address-form"
      data-testid="address-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(a);
      }}
    >
      {field('name', 'Name', { autoComplete: 'name' })}
      {field('line1', 'Street address', { required: true, autoComplete: 'address-line1' })}
      {field('line2', 'Apt, suite (optional)', { autoComplete: 'address-line2' })}
      <div className="address-row">
        {field('city', 'City', { required: true })}
        {field('state', 'State', { required: true, maxLength: 20, autoCapitalize: 'characters' })}
        {field('postalCode', 'ZIP', { required: true, inputMode: 'numeric', maxLength: 10 })}
      </div>
      <div className="ship-form-actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save address'}
        </button>
      </div>
    </form>
  );
}

export function OrderDetail({ order: o, startShipping, onClose, act, notify }: Props) {
  const [busy, setBusy] = useState(false);
  const [shipping, setShipping] = useState(Boolean(startShipping) && o.stage === 'ready_to_ship');
  const [editTracking, setEditTracking] = useState(false);
  /** Asking "has shipping already been paid?" while changing to shipping. */
  const [askPaid, setAskPaid] = useState(false);
  const [editAddress, setEditAddress] = useState(false);
  const [confirm, setConfirm] = useState<null | {
    title: string;
    body: string;
    label: string;
    req: FulfillmentRequest;
    danger?: boolean;
    done: string;
  }>(null);
  const [error, setError] = useState<string | null>(null);
  const [flagging, setFlagging] = useState(false);
  const [flagNote, setFlagNote] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [o.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirm) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirm]);

  const expect = (x: Order) => ({
    expectedStatus: x.fulfillment.status,
    expectedMethod: x.fulfillment.method,
    expectedShippingPayment: x.shippingPayment.status,
  });

  const run = async (req: FulfillmentRequest, done: string, undo?: FulfillmentRequest) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await act(o.id, { ...req, ...expect(o) });
      setShipping(false);
      setEditTracking(false);
      setAskPaid(false);
      setEditAddress(false);
      setConfirm(null);
      notify(
        done,
        undo ? { undo: () => void act(o.id, { ...undo, ...expect(updated) }).catch(() => notify('Could not undo.', { kind: 'error' })) } : undefined,
      );
      return true;
    } catch (err) {
      setConfirm(null);
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const f = o.fulfillment;
  const sp = o.shippingPayment;
  const waiting = f.status === 'waiting' && o.stage !== 'refunded';
  const paymentBlocked = o.issues.some((i) => ['payment_incomplete', 'payment_processing', 'session_not_complete'].includes(i.code));
  const problemList = o.issues.filter((i) => i.severity === 'problem');
  const warningList = o.issues.filter((i) => i.severity === 'warning');
  const checkList = checks(o);
  const emailLink = customerEmailLink(o);
  const cc = o.customerCheck;
  const canDismissCheck = checkList.some((i) => i.code !== 'unknown_method');
  const track = trackingUrl(f.carrier, f.trackingNumber);
  const stripeUrl = stripeDashboardUrl(o);
  // Only ask "already paid?" when Stripe didn't charge shipping AND checkout wasn't a (free-)shipping order.
  const needsPaidQuestion = o.checkout.shippingCharged === 0 && o.checkout.choice !== 'shipping';

  // Where to mail it, next to the button that says it's been mailed. Editable: the customer may email a new address.
  const shipTo =
    f.method !== 'shipping' || !waiting ? null : editAddress ? (
      <AddressForm
        initial={f.address}
        busy={busy}
        onCancel={() => setEditAddress(false)}
        onSubmit={(address) => void run({ action: 'set_shipping_address', address }, 'Address saved')}
      />
    ) : f.address ? (
      <div className="ship-to">
        <span className="ship-to-label">Ship to</span>
        <AddressBlock address={f.address} copyable />
        <span className="muted small">
          {f.addressSource === 'dashboard' ? 'Entered by you' : 'From checkout'} ·{' '}
          <button className="link-btn inline" onClick={() => setEditAddress(true)}>
            Change address
          </button>
          {f.addressSource === 'dashboard' && f.checkoutAddress && (
            <>
              {' · '}
              <button className="link-btn inline" onClick={() => void run({ action: 'set_shipping_address', address: null }, 'Using the checkout address')}>
                Use checkout address
              </button>
            </>
          )}
        </span>
      </div>
    ) : (
      <div className="ship-to">
        <span className="ship-to-label">Ship to</span>
        <span className="text-warn">No mailing address yet</span>
        <button className="btn btn-secondary" onClick={() => setEditAddress(true)}>
          Add mailing address
        </button>
      </div>
    );

  const changeToShipping = () => {
    if (needsPaidQuestion) setAskPaid(true);
    else void run({ action: 'change_to_shipping' }, 'Changed to shipping', { action: 'change_to_pickup' });
  };

  const paidQuestion = (
    <div className="ask-paid" data-testid="ask-shipping-paid">
      <p>
        <strong>Has the customer already paid for shipping?</strong>
      </p>
      <div className="btn-pair">
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => run({ action: 'change_to_shipping', shippingPaid: false }, 'Changed to shipping — shipping unpaid', { action: 'change_to_pickup' })}
        >
          Not yet
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => run({ action: 'change_to_shipping', shippingPaid: true }, 'Changed to shipping — ready to ship', { action: 'change_to_pickup' })}
        >
          Yes, it’s paid
        </button>
      </div>
      <button className="link-btn" onClick={() => setAskPaid(false)}>
        Cancel
      </button>
    </div>
  );

  // ---------- "what's next" ----------
  let next: ReactNode = null;
  const links: ReactNode[] = [];

  if (paymentBlocked) {
    next = <p className="action-note">Nothing to do until the payment goes through. Don’t hand over or ship this book yet.</p>;
  } else if (o.stage === 'refunded') {
    next = <p className="action-note">This order was refunded. Nothing to do.</p>;
  } else if (waiting && f.method === null) {
    next = askPaid ? (
      paidQuestion
    ) : (
      <div className="action-choose">
        <p className="action-note">Is this a pickup, or should it be mailed?</p>
        <div className="btn-pair">
          <button className="btn btn-secondary btn-big" disabled={busy} onClick={() => run({ action: 'change_to_pickup' }, 'Set as pickup')}>
            <Icon name="hand" /> It’s a pickup
          </button>
          <button className="btn btn-secondary btn-big" disabled={busy} onClick={changeToShipping}>
            <Icon name="truck" /> Mail it
          </button>
        </div>
      </div>
    );
  } else if (waiting && f.method === 'pickup') {
    next = askPaid ? (
      paidQuestion
    ) : (
      <button
        className="btn btn-primary btn-big btn-block"
        disabled={busy}
        onClick={() => run({ action: 'mark_picked_up' }, 'Marked as picked up', { action: 'mark_waiting' })}
      >
        <Icon name="check" /> {busy ? 'Saving…' : 'Mark as picked up'}
      </button>
    );
    if (!askPaid) {
      links.push(
        <button key="toship" className="link-btn" disabled={busy} onClick={changeToShipping}>
          Customer wants it mailed? Change to shipping
        </button>,
      );
    }
  } else if (waiting && f.method === 'shipping' && sp.status === 'unpaid') {
    next = (
      <>
        <div className="shipunpaid-callout" data-testid="shipping-unpaid">
          <strong>Shipping unpaid</strong>
          <span>
            Once the customer has paid you for shipping (however they paid), record it here. This only records it — it doesn’t charge
            them.
          </span>
          <button
            className="btn btn-primary btn-big btn-block"
            disabled={busy}
            onClick={() => run({ action: 'mark_shipping_paid' }, 'Shipping marked paid — ready to ship', { action: 'mark_shipping_unpaid' })}
          >
            <Icon name="check" /> {busy ? 'Saving…' : 'Mark shipping paid'}
          </button>
        </div>
        {shipTo}
      </>
    );
  } else if (waiting && f.method === 'shipping') {
    next = shipping ? (
      <>
        {shipTo}
        <ShipForm
          submitLabel="Confirm shipped"
          busy={busy}
          onCancel={() => setShipping(false)}
          onSubmit={(carrier, trackingNumber) =>
            run({ action: 'mark_shipped', carrier, trackingNumber }, 'Marked as shipped', { action: 'mark_waiting' })
          }
        />
      </>
    ) : (
      <>
        {shipTo}
        {(f.address || cc.dismissed) && !editAddress && (
          <button className="btn btn-primary btn-big btn-block" disabled={busy} onClick={() => setShipping(true)}>
            <Icon name="truck" /> Mark as shipped
          </button>
        )}
      </>
    );
    if (sp.source !== 'checkout') {
      links.push(
        <button
          key="unpaid"
          className="link-btn"
          disabled={busy}
          onClick={() => run({ action: 'mark_shipping_unpaid' }, 'Marked shipping unpaid', { action: 'mark_shipping_paid' })}
        >
          Customer still owes shipping? Mark shipping unpaid
        </button>,
      );
    }
  } else if (f.status === 'completed' && f.method === 'shipping') {
    next = editTracking ? (
      <ShipForm
        initialCarrier={f.carrier}
        initialTracking={f.trackingNumber}
        submitLabel="Save tracking"
        busy={busy}
        onCancel={() => setEditTracking(false)}
        onSubmit={(carrier, trackingNumber) => run({ action: 'update_tracking', carrier, trackingNumber }, 'Tracking saved')}
      />
    ) : (
      <button className="btn btn-secondary" disabled={busy} onClick={() => setEditTracking(true)}>
        <Icon name="pen" size={16} /> {f.trackingNumber ? 'Edit tracking' : 'Add tracking'}
      </button>
    );
  }

  if (waiting && f.method === 'shipping' && !paymentBlocked) {
    links.push(
      <button
        key="topickup"
        className="link-btn"
        disabled={busy}
        onClick={() =>
          setConfirm({
            title: 'Change to pickup?',
            body:
              o.checkout.choice === 'pickup'
                ? 'This puts it back to pickup, the way it was ordered. Any shipping-payment note is cleared.'
                : 'The customer will pick it up instead of having it mailed. Any shipping-payment note is cleared.',
            label: 'Change to pickup',
            req: { action: 'change_to_pickup' },
            done: 'Changed to pickup',
          })
        }
      >
        {o.checkout.choice === 'pickup' ? 'Change back to pickup' : 'Change to pickup'}
      </button>,
    );
  }
  if (f.status === 'completed' && f.method && o.stage !== 'refunded') {
    const shipped = f.method === 'shipping';
    links.push(
      <button
        key="undo"
        className="link-btn"
        disabled={busy}
        onClick={() =>
          setConfirm({
            title: shipped ? 'Mark as not shipped?' : 'Mark as not picked up?',
            body: shipped
              ? 'This moves the order back to your to-do list and clears the shipped date and tracking.'
              : 'This moves the order back to your to-do list.',
            label: shipped ? 'Mark not shipped' : 'Mark not picked up',
            danger: true,
            req: { action: 'mark_waiting' },
            done: shipped ? 'Marked as not shipped' : 'Marked as not picked up',
          })
        }
      >
        <Icon name="undo" size={14} /> {shipped ? 'Undo: mark as not shipped' : 'Undo: mark as not picked up'}
      </button>,
    );
  }
  if (o.bucket === 'needs_action' && !cc.manual && !cc.open && !flagging) {
    links.push(
      <button key="flag" className="link-btn" disabled={busy} onClick={() => setFlagging(true)}>
        Flag to check with customer
      </button>,
    );
  }

  const shippingPaymentText =
    f.method !== 'shipping'
      ? 'Not applicable (pickup)'
      : sp.status === 'unpaid'
        ? null
        : sp.status === 'paid' && sp.source === 'checkout'
          ? `Paid at checkout (${money(o.checkout.shippingCharged, o.amounts.currency)})`
          : sp.status === 'paid'
            ? `Paid — recorded by you${sp.paidAt ? ` ${dateTime(sp.paidAt)}` : ''} (not a Stripe payment)`
            : 'Nothing owed (no shipping charge)';

  return (
    <div className="detail" role="dialog" aria-modal="false" aria-labelledby="detail-name" data-testid="order-detail">
      <header className="detail-head">
        <button type="button" className="icon-btn detail-back" onClick={onClose} aria-label="Back to orders">
          <Icon name="back" size={22} />
        </button>
        <div className="detail-title">
          <h2 id="detail-name" ref={headingRef} tabIndex={-1}>
            {o.customer.name || o.customer.email || 'Unknown customer'}
          </h2>
          <p>
            {editionLine(o)} · {money(o.amounts.total, o.amounts.currency)}
          </p>
        </div>
      </header>

      <div className="detail-body">
        <div className="detail-state">
          <StageBadge order={o} large />
          <RowBadges order={o} context="queue" omitStage />
        </div>

        {problemList.length > 0 && (
          <ul className="problems">
            {problemList.map((i) => (
              <li key={i.code}>
                <Icon name="alert" size={16} /> {i.message}
              </li>
            ))}
          </ul>
        )}

        {checkList.length > 0 && o.bucket === 'needs_action' && (
          <div className="check-callout" data-testid="check-customer">
            <strong>Check with customer</strong>
            <p>Nothing’s wrong on your end. Customers sometimes pick the wrong option at checkout, and a quick email usually sorts it out.</p>
            <ul>
              {checkList.map((i) => (
                <li key={i.code}>{i.message}</li>
              ))}
            </ul>
            {cc.contactedAt && <p className="muted">You emailed them {dateTime(cc.contactedAt)}.</p>}
            {emailLink ? (
              <a className="btn btn-primary btn-block" href={emailLink}>
                <Icon name="mail" /> Email customer
              </a>
            ) : (
              <p className="muted">There’s no email address on this order.</p>
            )}
            <div className="btn-pair">
              <button className="btn btn-secondary" disabled={busy} onClick={() => run({ action: 'mark_customer_contacted' }, 'Noted that you emailed them')}>
                I’ve emailed them
              </button>
              {canDismissCheck && (
                <button className="btn btn-quiet" disabled={busy} onClick={() => run({ action: 'resolve_customer_check' }, 'Marked as sorted')}>
                  Sorted, nothing to do
                </button>
              )}
            </div>
          </div>
        )}

        {o.signed && (
          <div className="sign-callout">
            <strong>Sign this copy</strong>
            {o.inscriptionName ? <span>Inscribe to: “{o.inscriptionName}”</span> : <span>No inscription name given</span>}
          </div>
        )}

        <section className="actions" aria-label="Next step">
          {next}
          {error && (
            <p className="action-error" role="alert">
              {error}
            </p>
          )}
          {links.length > 0 && <div className="action-links">{links}</div>}
          {flagging && (
            <form
              className="check-note-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run({ action: 'flag_customer_check', note: flagNote.trim() }, 'Flagged to check with customer').then((ok) => {
                  if (ok) {
                    setFlagging(false);
                    setFlagNote('');
                  }
                });
              }}
            >
              <label className="field">
                <span>What do you want to check? (optional)</span>
                <input value={flagNote} onChange={(e) => setFlagNote(e.target.value)} maxLength={120} placeholder="e.g. lives in Austin — pickup or mail?" />
              </label>
              <div className="ship-form-actions">
                <button type="button" className="btn btn-quiet" onClick={() => setFlagging(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Flag it
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="card-section">
          <h3>Customer</h3>
          <dl>
            <Row label="Name">{o.customer.name || '—'}</Row>
            <Row label="Email">{o.customer.email ? <a href={`mailto:${o.customer.email}`}>{o.customer.email}</a> : '—'}</Row>
            <Row label="Phone">{o.customer.phone ? <a href={`tel:${o.customer.phone}`}>{o.customer.phone}</a> : '—'}</Row>
          </dl>
        </section>

        <section className="card-section">
          <h3>Order</h3>
          <dl>
            {o.items
              .filter((i) => i.kind === 'book')
              .map((i, n) => (
                <Row key={n} label={n === 0 ? 'Book' : ' '}>
                  {i.quantity > 1 ? `${i.quantity} × ` : ''}
                  {i.format ? FORMAT_LABEL[i.format] : 'Format unknown'} · {i.language ? LANGUAGE_LABEL[i.language] : 'Language unknown'}
                  <span className="muted small block">{i.productName || i.description}</span>
                </Row>
              ))}
            <Row label="Quantity">{o.book.quantity}</Row>
            <Row label="Signed">{o.signed === null ? 'Not recorded' : o.signed ? 'Yes' : 'No'}</Row>
            {o.signed && <Row label="Inscription">{o.inscriptionName || '—'}</Row>}
          </dl>
        </section>

        <section className="card-section" data-testid="fulfillment-facts">
          <h3>Fulfillment</h3>
          <dl>
            <Row label="Ordered as">
              {METHOD_LABEL[o.checkout.choice]}
              {o.checkout.shippingRateName && <span className="muted small block">Option chosen: {o.checkout.shippingRateName}</span>}
              <span className="muted small block">What the customer chose at checkout (from Stripe)</span>
            </Row>
            <Row label="Now">
              {f.method ? METHOD_LABEL[f.method] : 'Not decided yet'}
              {f.changedFromCheckout && (
                <span className="muted small block">Changed in this dashboard{f.methodChangedAt ? ` ${dateTime(f.methodChangedAt)}` : ''}</span>
              )}
            </Row>
            <Row label="Shipping payment">{shippingPaymentText ?? <span className="text-warn">Unpaid — customer still owes shipping</span>}</Row>
            {f.method === 'shipping' && (
              <Row label="Ship to">
                {f.address ? <AddressBlock address={f.address} copyable /> : <span className="text-warn">No mailing address yet</span>}
                {!f.address && f.billingAddress && (
                  <span className="muted small block">
                    Card billing address (may not be where to ship):{' '}
                    {[f.billingAddress.line1, f.billingAddress.city, f.billingAddress.state, f.billingAddress.postalCode].filter(Boolean).join(', ')}
                  </span>
                )}
              </Row>
            )}
            {f.method === 'pickup' && f.address && (
              <Row label="Address on file">
                <AddressBlock address={f.address} copyable />
              </Row>
            )}
            <Row label="Status">
              {f.status === 'completed' ? (f.method === 'shipping' ? 'Shipped' : 'Picked up') : f.noStatusRecorded ? 'Not done yet (no status recorded)' : 'Not done yet'}
              {f.completedAt && <span className="muted small block">{dateTime(f.completedAt)}</span>}
              {f.updatedBy && f.updatedAt && <span className="muted small block">Last change by {f.updatedBy}, {dateTime(f.updatedAt)}</span>}
            </Row>
            {f.status === 'completed' && f.method === 'shipping' && (
              <Row label="Tracking">
                {f.trackingNumber ? (
                  <>
                    {f.carrier && <span>{f.carrier} </span>}
                    {track ? (
                      <a href={track} target="_blank" rel="noreferrer">
                        {f.trackingNumber}
                      </a>
                    ) : (
                      <span className="selectable">{f.trackingNumber}</span>
                    )}
                  </>
                ) : (
                  <span className="muted">{f.carrier ? `${f.carrier}, no tracking number` : 'None'}</span>
                )}
              </Row>
            )}
          </dl>
        </section>

        <section className="card-section">
          <h3>Payment</h3>
          <dl>
            <Row label="Subtotal">{money(o.amounts.subtotal, o.amounts.currency)}</Row>
            {o.amounts.discount > 0 && <Row label="Discount">−{money(o.amounts.discount, o.amounts.currency)}</Row>}
            <Row label="Tax">{money(o.amounts.tax, o.amounts.currency)}</Row>
            <Row label="Shipping">{money(o.amounts.shipping, o.amounts.currency)}</Row>
            <Row label="Total">
              <strong>{money(o.amounts.total, o.amounts.currency)}</strong>
            </Row>
            <Row label="Payment">
              {{ paid: 'Paid', processing: 'Processing', unpaid: 'Not paid', no_payment_required: 'No payment needed' }[o.payment.state]}
              {o.payment.disputed && <span className="text-problem block">Disputed</span>}
            </Row>
            <Row label="Refund">
              {o.payment.refund === 'none' ? 'None' : o.payment.refund === 'full' ? 'Fully refunded' : 'Partly refunded'}
              {o.amounts.refunded > 0 && <span className="muted small block">{money(o.amounts.refunded, o.amounts.currency)} refunded</span>}
            </Row>
            <Row label="Purchased">{dateTime(o.createdAt)}</Row>
          </dl>
        </section>

        {warningList.length > 0 && (
          <section className="card-section">
            <h3>Notes</h3>
            <ul className="warnings">
              {warningList.map((i) => (
                <li key={i.code}>{i.message}</li>
              ))}
            </ul>
          </section>
        )}

        <details className="technical">
          <summary>Technical details</summary>
          <dl>
            <Row label="Checkout Session">
              <code className="selectable">{o.technical.sessionId}</code>
            </Row>
            <Row label="PaymentIntent">
              <code className="selectable">{o.technical.paymentIntentId || '—'}</code>
            </Row>
            <Row label="Charge">
              <code className="selectable">{o.technical.chargeId || '—'}</code>
            </Row>
            <Row label="Products">
              <code className="selectable">{o.technical.productIds.join(', ') || '—'}</code>
            </Row>
            <Row label="Prices">
              <code className="selectable">{o.technical.priceIds.join(', ') || '—'}</code>
            </Row>
            <Row label="Shipping rate">
              <code className="selectable">{o.technical.shippingRateId || '—'}</code>
            </Row>
            <Row label="Stripe status">
              <code>
                session {o.technical.sessionStatus} / payment {o.technical.paymentStatus} / {o.livemode ? 'live' : 'test'}
              </code>
            </Row>
            <Row label="Checkout choice">
              <code>
                {o.checkout.choice} ({o.checkout.choiceSource})
              </code>
            </Row>
            <Row label="How classified">
              <ul className="signals">
                {o.checkout.signals.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </Row>
            <Row label="Session metadata">
              <pre>{JSON.stringify(o.technical.metadata, null, 2)}</pre>
            </Row>
            {Object.keys(o.technical.paymentIntentMetadata).length > 0 && (
              <Row label="PaymentIntent metadata">
                <pre>{JSON.stringify(o.technical.paymentIntentMetadata, null, 2)}</pre>
              </Row>
            )}
            {o.technical.customFields.length > 0 && (
              <Row label="Custom fields">
                <pre>{JSON.stringify(o.technical.customFields, null, 2)}</pre>
              </Row>
            )}
          </dl>
          {stripeUrl && (
            <a className="btn btn-quiet btn-small" href={stripeUrl} target="_blank" rel="noreferrer">
              Open in Stripe <Icon name="external" size={14} />
            </a>
          )}
        </details>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(confirm.req, confirm.done)}
        />
      )}
    </div>
  );
}
