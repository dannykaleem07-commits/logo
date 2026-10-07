// @vitest-environment jsdom
/**
 * Smoke test: the damage model in jsdom (no WebGL) falls back to the 2D SVG views, lists damage, and edits through the
 * popover and the list. Also checks the lazy public wrapper resolves.
 */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DamageModel3D, { detectWebGL } from './DamageModel3D';
import { DamageModel3D as LazyDamageModel3D } from './index';
import type { DamageMap } from './damageModel';

afterEach(cleanup);

function Harness({ initial, onChange }: { initial: DamageMap; onChange?: (d: DamageMap) => void }) {
  const [d, setD] = useState(initial);
  return (
    <DamageModel3D
      bodyType="5 DOOR HATCHBACK"
      damage={d}
      onChange={(n) => {
        setD(n);
        onChange?.(n);
      }}
    />
  );
}

describe('DamageModel3D (2D fallback)', () => {
  it('has no WebGL in jsdom and renders the five SVG views with zones', () => {
    expect(detectWebGL()).toBe(false);
    render(<Harness initial={{}} />);
    const grid = screen.getByTestId('damage-2d');
    expect(within(grid).getAllByRole('img')).toHaveLength(5);
    expect(screen.getByRole('img', { name: 'Left side (N/S) view' })).toBeTruthy();
    expect(grid.querySelectorAll('[data-zone="front_door_l"]').length).toBeGreaterThan(0);
    expect(grid.querySelectorAll('[data-zone="tailgate"]').length).toBeGreaterThan(0);
    expect(screen.getByText('No damage marked')).toBeTruthy();
    expect(screen.getByRole('button', { name: '3D' })).toHaveProperty('disabled', true);
  });

  it('colours damaged zones and lists them, heaviest first', () => {
    render(
      <Harness
        initial={{
          rear_bumper: { severity: 1, source: 'user' },
          front_bumper: { severity: 3, operation: 'replace', source: 'user' },
          headlamp_r: { severity: 2, source: 'ai', confidence: 0.86 }
        }}
      />
    );
    const path = screen.getByTestId('damage-2d').querySelector('[data-zone="front_bumper"]')!;
    expect(path.getAttribute('fill')).toBe('#d23b3b');
    const list = screen.getByRole('complementary', { name: 'Damaged parts' });
    const titles = within(list).getAllByRole('button', { name: /Edit$/ }).map((b) => b.getAttribute('aria-label'));
    expect(titles[0]).toMatch(/^Front bumper: Heavy · Replace/);
    expect(titles[1]).toMatch(/^Headlamp \(O\/S, right\): Medium · AI 86%/);
    expect(screen.getByText('3 parts damaged: 1 heavy, 1 medium, 1 light')).toBeTruthy();
  });

  it('click a zone → popover → set severity and operation; remove from the list', () => {
    const onChange = vi.fn();
    render(<Harness initial={{}} onChange={onChange} />);
    const door = screen.getByTestId('damage-2d').querySelector('[data-zone="front_door_l"]')!;
    fireEvent.click(door, { clientX: 100, clientY: 100 });
    const pop = screen.getByRole('dialog', { name: 'Damage to Front door (N/S, left)' });
    fireEvent.click(within(pop).getByRole('button', { name: 'Heavy' }));
    expect(onChange).toHaveBeenLastCalledWith({ front_door_l: { severity: 3, operation: 'replace', source: 'user' } });
    fireEvent.click(within(pop).getByRole('button', { name: 'Paint' }));
    expect(onChange).toHaveBeenLastCalledWith({ front_door_l: { severity: 3, operation: 'paint', source: 'user' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove damage to Front door (N/S, left)' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('adds a list-only part from the picker', () => {
    const onChange = vi.fn();
    render(<Harness initial={{}} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Add a damaged part' });
    expect(within(select).getByRole('option', { name: 'Floor pan (list only)' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'floor_pan' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Medium' }));
    expect(onChange).toHaveBeenLastCalledWith({ floor_pan: { severity: 2, operation: 'repair', source: 'user' } });
  });

  it('is read-only without onChange', () => {
    render(<DamageModel3D bodyType="panel-van" damage={{ sliding_door_r: { severity: 2, source: 'user' } }} />);
    fireEvent.click(screen.getByTestId('damage-2d').querySelector('[data-zone="sliding_door_r"]')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(within(screen.getByRole('complementary', { name: 'Damaged parts' })).getByText('Sliding side door (O/S, right)')).toBeTruthy();
  });

  it('the lazy public wrapper loads the component', async () => {
    await act(async () => {
      render(<LazyDamageModel3D bodyType="suv" damage={{}} forceFallback />);
    });
    await waitFor(() => expect(screen.getByTestId('damage-2d')).toBeTruthy());
    expect(screen.getByTestId('damage-2d').querySelectorAll('[data-zone="wheel_arch_trim_l"]').length).toBeGreaterThan(0);
  });
});
