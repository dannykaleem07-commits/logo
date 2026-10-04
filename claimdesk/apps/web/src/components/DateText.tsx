import type { ISODate, ISODateTime } from '@ccguk/domain';
import { formatDate, formatDateTime } from '../lib/dates';

export function DateText({ value, time = false, long = false }: { value: ISODate | ISODateTime | null | undefined; time?: boolean; long?: boolean }) {
  if (!value) return <span className="muted">—</span>;
  return <time dateTime={value}>{time ? formatDateTime(value) : formatDate(value, { long })}</time>;
}
