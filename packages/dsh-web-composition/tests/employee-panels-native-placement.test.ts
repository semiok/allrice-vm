import { describe, expect, it } from 'vitest';
import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';
import {
  assertPlacementAncestors,
  classifyNativePlacementEffect,
  placementRootIdentity,
} from './employee-panels-native-placement';

const pixels = (a: number | null, b = a) => ({
  formalElement: { changedPixels: a },
  fullFramePanelWindow: { changedPixels: b },
});
const counts = () => ({
  baseline: pixels(56, 80),
  transform: pixels(0),
  layout: pixels(56, 80),
  returned: pixels(0),
  mechanism: pixels(56, 80),
});
const exact = { formalElement: true, fullFramePanelWindow: true };
describe('D same-run placement dependency', () => {
  it('records a reversible contrast without claiming a product fix', () => {
    const value = classifyNativePlacementEffect(true, counts(), exact);
    expect(value.status).toBe('supported');
    expect(value.provesProductRepair).toBe(false);
  });
  it('accepts no effect and does not assume either mechanism must match', () => {
    const input = counts();
    input.transform = input.layout;
    input.returned = input.transform;
    input.mechanism = pixels(0);
    expect(classifyNativePlacementEffect(true, input, exact).status).toBe(
      'no-observable-effect',
    );
  });
  it('does not borrow the historical residual when this baseline already matches', () => {
    const value = classifyNativePlacementEffect(
      true,
      { ...counts(), baseline: pixels(0) },
      exact,
    );
    expect(value.status).toBe('not-supported');
    expect(value.captures.formalElement.mechanismPixelsDiffer).toBe(true);
  });
  it('keeps mixed capture outcomes separate', () => {
    const value = classifyNativePlacementEffect(
      true,
      { ...counts(), layout: pixels(0, 80), mechanism: pixels(0, 80) },
      exact,
    );
    expect(value.status).toBe('not-supported');
    expect(value.captures.formalElement.status).toBe('no-observable-effect');
  });
  it('rejects an invalid control even with a favorable pixel pattern', () => {
    expect(classifyNativePlacementEffect(false, counts(), exact).status).toBe(
      'invalid-experiment',
    );
  });
  it('requires byte-exact returns and actual complete measurements', () => {
    for (const value of [
      classifyNativePlacementEffect(true, counts(), {
        ...exact,
        formalElement: false,
      }),
      classifyNativePlacementEffect(
        true,
        { ...counts(), returned: pixels(1) },
        exact,
      ),
      classifyNativePlacementEffect(
        true,
        { ...counts(), mechanism: pixels(null) },
        exact,
      ),
    ])
      expect(value.status).toBe('invalid-experiment');
  });
});

const node = (identity: number, parentIdentity: number | null) => ({
  identity,
  parentIdentity,
  tag: 'DIV',
  className: null,
  rect: { x: 0, y: 0, width: 1440, height: 1000 },
  styles: {
    position: 'relative',
    transform: 'matrix(1, 0, 0, 1, 0, 0)',
    'overflow-x': 'visible',
    'clip-path': 'none',
  },
});
const snapshot = (ancestors: unknown[]) =>
  ({ ancestors }) as PanelsCausalSnapshot;
const before = () => snapshot([node(1, 3), { ...node(3, null), tag: 'BODY' }]);
const placed = before;
const offset = { x: -793, y: -38 };
describe('D actual ancestor controls', () => {
  it('retains the original native app as the only controlled ancestor', () => {
    expect(placementRootIdentity(before(), before())).toBe(1);
  });
  it('rejects replacement, extra ancestors or attachment geometry changes', () => {
    const replacement = before(),
      extra = before(),
      deformed = before();
    replacement.ancestors[0]!.identity = 7;
    extra.ancestors.push(node(9, null) as never);
    deformed.ancestors[0]!.rect.width++;
    for (const value of [replacement, extra, deformed])
      expect(() => placementRootIdentity(before(), value)).toThrow(
        'Invalid native placement',
      );
  });
  it('permits only the measured app matrix at fixed boxes', () => {
    const a = placed(),
      b = placed();
    a.ancestors[0]!.styles.transform = 'matrix(1, 0, 0, 1, -793, -38)';
    expect(() => assertPlacementAncestors(a, b, 1, offset)).not.toThrow();
  });
  it('rejects clipping, geometry, unknown matrix and ownership changes', () => {
    const changes = [placed(), placed(), placed(), placed()];
    changes[0]!.ancestors[0]!.styles['overflow-x'] = 'hidden';
    changes[1]!.ancestors[0]!.rect.x = 1;
    changes[2]!.ancestors[0]!.styles.transform = 'matrix(2, 0, 0, 1, 0, 0)';
    changes[3]!.ancestors[0]!.identity = 8;
    for (const value of changes)
      expect(() =>
        assertPlacementAncestors(placed(), value, 1, offset),
      ).toThrow('Invalid native placement');
  });
});
