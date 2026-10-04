import type { KeyboardEvent, MouseEvent } from 'react';
import type { Order } from '../../shared/types';
import { checks, customerEmailLink, editionLine, money, problems, shortDate } from '../lib/format';
import { AddressBlock } from './Address';
import { RowBadges } from './Badges';
import { Icon } from './Icon';

export type RowAction = 'picked_up' | 'ship' | 'shipping_paid';

interface Props {
  order: Order;
  /** 'queue' = inside a Needs Action section (normal state is implied by the section). */
  context: 'queue' | 'flat';
  onOpen(id: string): void;
  onAction?(o: Order, action: RowAction): void;
  busy?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?(id: string): void;
  isOpen?: boolean;
}

export function OrderRow({ order: o, context, onOpen, onAction, busy, selectable, selected, onToggleSelect, isOpen }: Props) {
  const open = () => (selectable && onToggleSelect ? onToggleSelect(o.id) : onOpen(o.id));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  const stop = (e: MouseEvent) => e.stopPropagation();
  const firstProblem = problems(o)[0];
  const firstCheck = o.bucket === 'needs_action' ? checks(o)[0] : undefined;
  const email = customerEmailLink(o);
  const qty = o.book.quantity > 1 ? `${o.book.quantity} books · ` : '';
  const showAddress = o.fulfillment.method === 'shipping' && o.fulfillment.address && o.stage !== 'refunded';
  const act = (a: RowAction) => onAction?.(o, a);

  let action = null;
  if (!selectable && onAction) {
    if (o.stage === 'waiting_for_pickup') {
      action = (
        <button type="button" className="btn btn-primary btn-row" disabled={busy} onClick={() => act('picked_up')}>
          <Icon name="check" size={16} /> {busy ? 'Saving…' : 'Mark as picked up'}
        </button>
      );
    } else if (o.stage === 'ready_to_ship') {
      action = (
        <button type="button" className="btn btn-primary btn-row" disabled={busy} onClick={() => act('ship')}>
          <Icon name="truck" size={16} /> Mark as shipped…
        </button>
      );
    } else if (o.stage === 'shipping_unpaid') {
      action = (
        <button type="button" className="btn btn-primary btn-row" disabled={busy} onClick={() => act('shipping_paid')}>
          <Icon name="check" size={16} /> {busy ? 'Saving…' : 'Mark shipping paid'}
        </button>
      );
    } else if (o.stage === 'check_customer' && email) {
      action = (
        <a className="btn btn-secondary btn-row" href={email}>
          <Icon name="mail" size={16} /> Email customer
        </a>
      );
    }
  }

  return (
    <article
      className={`order order-${o.stage}${selected ? ' is-selected' : ''}${isOpen ? ' is-open' : ''}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
      aria-label={`${o.customer.name ?? 'Unknown customer'}, ${editionLine(o)}`}
      data-testid="order-row"
      data-order-id={o.id}
    >
      {selectable && (
        <span className="o-check" aria-hidden="true">
          <input type="checkbox" checked={Boolean(selected)} readOnly tabIndex={-1} />
        </span>
      )}

      <div className="o-who">
        <h3 className="o-name">{o.customer.name || o.customer.email || 'Unknown customer'}</h3>
        <p className="o-edition">
          {qty}
          {editionLine(o)}
        </p>
        {o.signed && o.inscriptionName && <p className="o-inscription">Inscribe: “{o.inscriptionName}”</p>}
        <RowBadges order={o} context={context} />
        <p className="o-date">{shortDate(o.createdAt)}</p>
      </div>

      <div className="o-where">
        {showAddress && <AddressBlock address={o.fulfillment.address!} compact />}
        {firstCheck && o.stage !== 'problem' && (
          <p className="o-check-note">
            <Icon name="mail" size={15} /> {firstCheck.message}
          </p>
        )}
        {o.stage === 'problem' && firstProblem && (
          <p className="o-problem">
            <Icon name="alert" size={15} /> {firstProblem.message}
          </p>
        )}
        {o.stage === 'shipped' && o.fulfillment.trackingNumber && (
          <p className="o-tracking">
            {o.fulfillment.carrier ? `${o.fulfillment.carrier} ` : ''}
            {o.fulfillment.trackingNumber}
          </p>
        )}
      </div>

      <div className="o-total">{money(o.amounts.total, o.amounts.currency)}</div>

      <div className="o-action" onClick={stop}>
        {action}
      </div>
    </article>
  );
}
