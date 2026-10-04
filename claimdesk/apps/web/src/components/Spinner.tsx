export function Spinner({ size = 'sm', label }: { size?: 'sm' | 'lg'; label?: string }) {
  return (
    <span className={size === 'lg' ? 'spinner spinner-lg' : 'spinner'} role="status" aria-label={label ?? 'Loading'} />
  );
}

/** Centred loading block for a card or page. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <Spinner size="lg" label={label} />
      <span>{label}</span>
    </div>
  );
}
