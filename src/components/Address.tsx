import { useState } from 'react';
import type { Address as Addr } from '../../shared/types';
import { addressLines } from '../lib/format';
import { Icon } from './Icon';

export function AddressBlock({ address, copyable = false, compact = false }: { address: Addr; copyable?: boolean; compact?: boolean }) {
  const lines = addressLines(address);
  const shown = compact ? lines.filter((l) => l !== address.name) : lines;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* selection still works */
    }
  };
  return (
    <div className={`address${compact ? ' address-compact' : ''}`}>
      <address>
        {shown.map((l, i) => (
          <span key={i}>
            {l}
            <br />
          </span>
        ))}
      </address>
      {copyable && (
        <button type="button" className="btn btn-quiet btn-small" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={15} /> {copied ? 'Copied' : 'Copy address'}
        </button>
      )}
    </div>
  );
}
