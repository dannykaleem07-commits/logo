// @vitest-environment jsdom
/**
 * Typing guard (docs/V03-MANAGER-MODE-HIRE-PRICING.md §D — "every time I type it clicks off per character").
 * Every keystroke must leave the focus in the field and the value must come out exactly as typed, inside dialogs whose
 * parent re-renders and passes a new `onClose` closure each time. Also: nested modals (Escape closes only the inner
 * one), focus back to the opener, the DateTimeInput / DateInput draft, and the real UnitDialog, ReasonDialog and
 * StatusControl dialogs.
 */
import { useEffect, useState } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../components/Button';
import { DateInput, DateTimeInput, MoneyInput, TextArea, TextInput } from '../components/Form';
import { Modal } from '../components/Modal';
import { ReasonDialog } from '../screens/claim/components/ReasonDialog';
import { StatusControl } from '../screens/claim/components/StatusControl';
import { UnitDialog } from '../screens/fleet/UnitDialog';
import { renderWithProviders, typeAndExpectFocus } from './harness';

// ---------------------------------------------------------------------------
// A fake API behind fetch: GETs answer with empty lists (after a short delay, so answers land while typing).
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status < 400,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text
  } as unknown as Response;
}

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api/, '');
  let body: unknown = { items: [] };
  if (path === '/catalogue/features') body = { version: 1, categories: [] };
  else if (path === '/settings') body = { lookupMode: 'manual' };
  else if (path === '/gta/suggest') body = { group: null, confidence: 'low', basis: 'none', reason: '', rate: null, note: '' };
  else if (path === '/auth/manager-mode') body = { allowed: true, on: false, idleMinutes: 60, defaultReason: 'Manager override' };
  return new Promise((resolve) => setTimeout(() => resolve(jsonResponse(body)), 5));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// A form in a Modal whose onClose is an inline closure over the form state (the shape of every dialog in the app)
// ---------------------------------------------------------------------------

function FormDialog({ churnMs }: { churnMs?: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [odometer, setOdometer] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // The parent re-renders on its own (like a query refetch) while the user types.
  useEffect(() => {
    if (!open || !churnMs) return;
    const t = window.setInterval(() => setTick((n) => n + 1), churnMs);
    return () => window.clearInterval(t);
  }, [open, churnMs]);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Open form</Button>
      <span data-testid="rate">{rate === null ? 'null' : String(rate)}</span>
      <span data-testid="tick">{tick}</span>
      <Modal
        open={open}
        title="Form"
        onClose={() => {
          // a new closure on every render, reading the form state
          if (name || note || odometer || rate !== null || tick >= 0) setOpen(false);
        }}
        footer={<Button onClick={() => setOpen(false)}>Cancel</Button>}
      >
        <TextInput label="Name" value={name} onChange={setName} />
        <TextArea label="Note" value={note} onChange={setNote} />
        <TextInput label="Odometer out" value={odometer} onChange={setOdometer} inputMode="numeric" />
        <MoneyInput label="Daily rate" value={rate} onChange={setRate} />
      </Modal>
    </div>
  );
}

describe('Modal keeps the focus in the field while typing', () => {
  it('TextInput, TextArea, numeric TextInput and MoneyInput: focus kept, values exact', async () => {
    const { user } = renderWithProviders(<FormDialog />);
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const d = screen.getByRole('dialog', { name: 'Form' });
    await typeAndExpectFocus(user, within(d).getByLabelText('Name') as HTMLInputElement, 'Ab1 9.5x');
    await typeAndExpectFocus(user, within(d).getByLabelText('Note') as HTMLTextAreaElement, 'Client returned the car');
    await typeAndExpectFocus(user, within(d).getByLabelText('Odometer out') as HTMLInputElement, '12345');
    const rate = within(d).getByLabelText('Daily rate') as HTMLInputElement;
    await typeAndExpectFocus(user, rate, '49.99');
    expect(screen.getByTestId('rate').textContent).toBe('4999');
    // Blur reformat leaves the full amount (the original bug left "4.00").
    await user.tab();
    expect(rate.value).toBe('49.99');
  });

  it('the parent re-rendering with a new onClose every 50 ms while typing does not steal the focus', async () => {
    const { user } = renderWithProviders(<FormDialog churnMs={50} />);
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const d = screen.getByRole('dialog', { name: 'Form' });
    const slow = (await import('@testing-library/user-event')).default.setup({ delay: 20 });
    await typeAndExpectFocus(slow, within(d).getByLabelText('Name') as HTMLInputElement, 'Typing slowly');
    await typeAndExpectFocus(slow, within(d).getByLabelText('Odometer out') as HTMLInputElement, '12345');
    await typeAndExpectFocus(slow, within(d).getByLabelText('Daily rate') as HTMLInputElement, '49.99');
    expect(Number(screen.getByTestId('tick').textContent)).toBeGreaterThan(2);
  });

  it('opening the dialog focuses the dialog itself (once), and an autoFocus field keeps its focus', async () => {
    function AutoFocusDialog() {
      const [open, setOpen] = useState(false);
      const [v, setV] = useState('');
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Modal open={open} title="Auto" onClose={() => setOpen(false)}>
            <TextInput label="Reason" value={v} onChange={setV} autoFocus />
          </Modal>
        </>
      );
    }
    const { user } = renderWithProviders(<AutoFocusDialog />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const field = screen.getByLabelText('Reason') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    await user.keyboard('abc');
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// Nested modals and focus return
// ---------------------------------------------------------------------------

function Nested() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const [text, setText] = useState('');
  return (
    <>
      <Button onClick={() => setOuter(true)}>Open outer</Button>
      <Modal open={outer} title="Outer" onClose={() => setOuter(false)}>
        <TextInput label="Outer field" value={text} onChange={setText} />
        <Button onClick={() => setInner(true)}>Add policy</Button>
      </Modal>
      <Modal open={outer && inner} title="Inner" onClose={() => setInner(false)}>
        <p>Inner body</p>
      </Modal>
    </>
  );
}

describe('Nested modals', () => {
  it('Escape closes only the inner (top-most) modal, then the outer one', async () => {
    const { user } = renderWithProviders(<Nested />);
    await user.click(screen.getByRole('button', { name: 'Open outer' }));
    await user.click(screen.getByRole('button', { name: 'Add policy' }));
    expect(screen.getByRole('dialog', { name: 'Inner' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy();
    // focus is back on the button that opened the inner dialog
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add policy' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Outer' })).toBeNull();
  });

  it('the opener regains focus when the dialog closes (Escape, ✕ or Cancel)', async () => {
    const { user } = renderWithProviders(<FormDialog />);
    const opener = screen.getByRole('button', { name: 'Open form' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(opener);
  });
});

// ---------------------------------------------------------------------------
// DateTimeInput / DateInput draft
// ---------------------------------------------------------------------------

function DateHost({ onModel }: { onModel: (v: string) => void }) {
  const [value, setValue] = useState<string>('2026-10-01T09:00:00.000Z');
  const [day, setDay] = useState<string>('2026-10-01');
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 20);
    return () => window.clearInterval(t);
  }, []);
  return (
    <Modal open title="Dates" onClose={() => undefined}>
      <DateTimeInput
        label="Hire started"
        value={value}
        onChange={(v) => {
          onModel(v);
          setValue(v);
        }}
      />
      <DateInput label="Service due" value={day as '' | `${number}-${number}-${number}`} onChange={(v) => setDay(v)} />
      <span data-testid="day">{day}</span>
      <Button onClick={() => setValue('2026-01-02T03:04:00.000Z')}>Reset</Button>
    </Modal>
  );
}

describe('DateTimeInput and DateInput keep a draft while typing', () => {
  it('a half-typed date-time (the browser reports "") is not pushed to the model nor wiped by a parent re-render', async () => {
    const seen: string[] = [];
    renderWithProviders(<DateHost onModel={(v) => seen.push(v)} />);
    const input = screen.getByLabelText('Hire started') as HTMLInputElement;
    input.focus();
    // half typed: the browser reports an empty value
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(seen).toEqual([]);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    // complete → pushed once, as UTC ISO
    fireEvent.change(input, { target: { value: '2026-10-05T10:30' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(new Date('2026-10-05T10:30').toISOString());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(input.value).toBe('2026-10-05T10:30');
  });

  it('an emptied box is pushed ("") on blur, and an outside reset resyncs the draft when not focused', async () => {
    const seen: string[] = [];
    const { user } = renderWithProviders(<DateHost onModel={(v) => seen.push(v)} />);
    const input = screen.getByLabelText('Hire started') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '' } });
    expect(seen).toEqual([]);
    fireEvent.blur(input);
    expect(seen).toEqual(['']);
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(input.value).toBe(toLocal('2026-01-02T03:04:00.000Z'));
  });

  it('DateInput: half-typed is held locally; a complete date is pushed', async () => {
    renderWithProviders(<DateHost onModel={() => undefined} />);
    const input = screen.getByLabelText('Service due') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId('day').textContent).toBe('2026-10-01');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '2026-11-30' } });
    expect(screen.getByTestId('day').textContent).toBe('2026-11-30');
  });
});

function toLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// The real dialogs
// ---------------------------------------------------------------------------

describe('Real dialogs keep the focus while typing', () => {
  it('ReasonDialog (inline onClose from the parent)', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      const [, setTick] = useState(0);
      useEffect(() => {
        const t = window.setInterval(() => setTick((n) => n + 1), 30);
        return () => window.clearInterval(t);
      }, []);
      return <ReasonDialog open={open} title="Clear flag" onClose={() => setOpen(false)} onConfirm={() => setOpen(false)} />;
    }
    const { user } = renderWithProviders(<Host />);
    const box = screen.getByLabelText(/Reason \(logged/) as HTMLTextAreaElement;
    await typeAndExpectFocus(user, box, 'Checked with the client by phone');
  });

  it('StatusControl: choosing a status opens the dialog; the reason box keeps the focus', async () => {
    const { user } = renderWithProviders(<StatusControl claimId="c1" status="fnol" hardStop={false} />);
    await user.selectOptions(screen.getByLabelText('Change status'), screen.getAllByRole('option')[1]!);
    const d = screen.getByRole('dialog');
    const box = within(d).getByRole('textbox') as HTMLTextAreaElement;
    await typeAndExpectFocus(user, box, 'Liability accepted by phone 12345');
  });

  it('UnitDialog (Add fleet unit): registration, make, model, daily rate, keeper address', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return <UnitDialog open={open} unit={null} onClose={() => setOpen(false)} />;
    }
    const { user } = renderWithProviders(<Host />);
    const d = screen.getByRole('dialog', { name: 'Add fleet unit' });
    await typeAndExpectFocus(user, within(d).getByLabelText(/^Registration/) as HTMLInputElement, 'FL25 MXX');
    await typeAndExpectFocus(user, within(d).getByLabelText(/^Make/) as HTMLInputElement, 'NISSAN');
    await typeAndExpectFocus(user, within(d).getByLabelText(/^Model/) as HTMLInputElement, 'QASHQAI');
    await typeAndExpectFocus(user, within(d).getByLabelText(/^Daily rate/) as HTMLInputElement, '74.68');
    // Keeper address may sit in a closed section (E4): open it first.
    const keeper = within(d).queryByText(/^Keeper address/, { selector: 'summary, summary *' });
    if (keeper) await user.click(keeper);
    await typeAndExpectFocus(user, within(d).getByLabelText('Address line 1') as HTMLInputElement, '1 High Street');
    await typeAndExpectFocus(user, within(d).getByLabelText('Postcode') as HTMLInputElement, 'NE1 4ST');
  });
});
