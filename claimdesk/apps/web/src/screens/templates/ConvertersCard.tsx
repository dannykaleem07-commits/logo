import { useDocxConverters, useRefreshDocxConverters } from '../../api/templatesApi';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { converterLines } from './templates';

/** Which programs on this PC can turn an approved Word document into its PDF (GET /docx-converters). */
export function ConvertersCard() {
  const q = useDocxConverters();
  const refresh = useRefreshDocxConverters();
  const lines = converterLines(q.data);
  return (
    <Card
      title="PDF converters"
      actions={
        <Button size="sm" variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
          Check again
        </Button>
      }
    >
      <div className="stack-sm">
        <div className="small strong">PDFs are produced with:</div>
        <ul className="converter-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {lines.map((l) => (
            <li key={l.id}>
              <Badge tone={l.ok ? 'green' : 'grey'}>{l.state}</Badge>
              <span>{l.name}</span>
              {l.preferred && <span className="xs muted">used first</span>}
              {l.detail && (
                <span className="xs muted mono" title={l.detail}>
                  {l.detail.length > 60 ? `${l.detail.slice(0, 60)}…` : l.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="xs muted" style={{ margin: 0 }}>
          The PDF is made when a Word document is approved, and its hash is recorded then. Microsoft Word gives the closest match to the printed template; LibreOffice is close; the built-in browser always works.
        </p>
        <ApiErrorNotice error={q.error ?? refresh.error} what="check the PDF converters" />
      </div>
    </Card>
  );
}
