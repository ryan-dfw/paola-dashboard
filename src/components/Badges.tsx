import type { ReactElement } from 'react';
import type { Order, Stage } from '../../shared/types';
import { stageLabel } from '../lib/format';
import { Icon } from './Icon';

// Badges are for EXCEPTIONS and facts that need attention. Normal state
// ("waiting for pickup", "ready to ship", "paid") is communicated by which
// section a row sits in and by its action button, not by a badge.

/** Stages that deserve emphasis even inside their own queue section. */
const LOUD: Stage[] = ['shipping_unpaid', 'problem'];

export function StageBadge({ order, large = false }: { order: Order; large?: boolean }) {
  const icon =
    order.stage === 'problem'
      ? 'alert'
      : order.stage === 'check_customer'
        ? 'mail'
        : order.stage === 'shipped' || order.stage === 'picked_up'
          ? 'check'
          : null;
  return (
    <span className={`badge stage stage-${order.stage}${large ? ' stage-large' : ''}`} data-testid="stage-badge">
      {icon && <Icon name={icon} size={large ? 18 : 14} />}
      {stageLabel(order)}
    </span>
  );
}

/**
 * The badges a row shows.
 *  - queue: inside a Needs Action section → only exceptions.
 *  - flat:  Completed / All / search results → the order's state first (no section to imply it), then exceptions.
 */
export function RowBadges({ order: o, context, omitStage }: { order: Order; context: 'queue' | 'flat'; omitStage?: boolean }) {
  const badges: ReactElement[] = [];
  if (!omitStage && (context === 'flat' || LOUD.includes(o.stage))) badges.push(<StageBadge key="stage" order={o} />);

  const { state, refund, disputed } = o.payment;
  if (disputed && o.stage !== 'problem') badges.push(<span key="d" className="badge pay pay-bad">Disputed</span>);
  else if (refund === 'partial') badges.push(<span key="r" className="badge pay pay-warn">Part refunded</span>);
  else if (o.stage !== 'problem' && o.stage !== 'refunded' && (state === 'unpaid' || state === 'processing')) {
    badges.push(
      <span key="p" className="badge pay pay-warn">
        {state === 'unpaid' ? 'Not paid' : 'Payment processing'}
      </span>,
    );
  }

  if (o.fulfillment.changedFromCheckout && o.fulfillment.method) {
    badges.push(
      <span key="c" className="badge info" title="Changed in the dashboard after checkout">
        {o.fulfillment.method === 'shipping' ? 'Now shipping · ordered as pickup' : 'Now pickup · ordered as shipping'}
      </span>,
    );
  }
  return badges.length ? <div className="o-badges">{badges}</div> : null;
}
