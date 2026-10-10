// @vitest-environment jsdom
/** Settings > AI number fields keep what is typed and clamp only when the field is left (focus-sweep finding). */
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClampedNumberInput, clampInt } from './AiSettingsPage';

function Harness() {
  const [v, setV] = useState(12);
  return (
    <>
      <ClampedNumberInput value={v} min={1} max={50} label="Max turns" onCommit={setV} />
      <output data-testid="committed">{v}</output>
    </>
  );
}

describe('ClampedNumberInput', () => {
  it('clearing the field and typing 8 gives 8 (not 18); leaving the field clamps and commits', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Max turns') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '8' } });
    expect(input.value).toBe('8');
    expect(document.activeElement).toBe(input);
    fireEvent.blur(input);
    expect(screen.getByTestId('committed').textContent).toBe('8');
    fireEvent.change(input, { target: { value: '12345' } });
    expect(input.value).toBe('12345');
    fireEvent.blur(input);
    expect(screen.getByTestId('committed').textContent).toBe('50');
    expect(input.value).toBe('50');
  });

  it('clampInt keeps the old value for text that is not a whole number', () => {
    expect(clampInt('', 1, 50)).toBeUndefined();
    expect(clampInt('abc', 1, 50)).toBeUndefined();
    expect(clampInt('0', 1, 50)).toBe(1);
    expect(clampInt(' 7 ', 1, 50)).toBe(7);
  });
});
