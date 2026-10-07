/**
 * Settings → Appearance: Light, Dark or System, saved for the signed-in user on this computer (lib/theme.ts). The top-bar
 * sun / moon button changes the same choice. Documents and PDFs always preview on white paper.
 */
import type { JSX } from 'react';
import { useMe } from '../../api/hooks';
import { Card } from '../../components/Card';
import { THEME_SETTINGS, useTheme, type ThemeSetting } from '../../lib/theme';
import '../../styles/theme.css';

function Preview({ kind }: { kind: ThemeSetting }) {
  return (
    <span className={`appearance-preview appearance-preview-${kind}`} aria-hidden="true">
      <span className="ap-side" />
      <span className="ap-main">
        <span className="ap-line ap-line-strong" />
        <span className="ap-line" />
        <span className="ap-pill" />
      </span>
    </span>
  );
}

export function AppearanceCard(): JSX.Element {
  const userId = useMe().data?.id ?? null;
  const { setting, resolved, setSetting } = useTheme(userId);
  return (
    <Card id="appearance" title="Appearance">
      <div className="stack">
        <div className="appearance-options" role="radiogroup" aria-label="Appearance">
          {THEME_SETTINGS.map((t) => (
            <label key={t.value} className={`appearance-option ${setting === t.value ? 'is-selected' : ''}`}>
              <input type="radio" name="appearance" value={t.value} checked={setting === t.value} onChange={() => setSetting(t.value)} className="sr-only" />
              <Preview kind={t.value} />
              <span className="appearance-label">{t.label}</span>
              <span className="appearance-hint">{t.hint}</span>
            </label>
          ))}
        </div>
        <p className="xs muted" role="status">
          {setting === 'system' ? `Following this computer: ${resolved} right now.` : `${resolved === 'dark' ? 'Dark' : 'Light'} on this computer for your sign-in.`} Letters, invoices and PDFs always preview on white paper, exactly as they print.
        </p>
      </div>
    </Card>
  );
}
