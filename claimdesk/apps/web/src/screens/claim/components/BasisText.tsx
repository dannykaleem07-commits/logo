import { isGtaBasis } from '../lib/clocksView';

/**
 * Plain-English basis for a rule. GTA paragraphs are an industry benchmark for a non-subscriber (GTA 2.7(j));
 * the note is appended whenever the basis cites the GTA and does not already say so.
 */
export function BasisText({ basis, className = '' }: { basis: string | undefined; className?: string }) {
  if (!basis) return null;
  const gta = isGtaBasis(basis) && !/benchmark/i.test(basis);
  return (
    <span className={`basis ${className}`.trim()}>
      {basis}
      {gta && <span className="gta-note"> · industry benchmark (CCGUK is not a GTA subscriber)</span>}
    </span>
  );
}
