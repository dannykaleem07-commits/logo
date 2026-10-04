import type { ReactNode } from 'react';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  hidden?: boolean;
}

export function KeyValue({ items, stack = false }: { items: KeyValueItem[]; stack?: boolean }) {
  return (
    <dl className={stack ? 'kv kv-stack' : 'kv'}>
      {items
        .filter((i) => !i.hidden)
        .map((i, idx) => (
          <div key={idx} style={{ display: 'contents' }}>
            <dt>{i.label}</dt>
            <dd>{i.value ?? '—'}</dd>
          </div>
        ))}
    </dl>
  );
}
