import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';

type Capture = 'formalElement' | 'fullFramePanelWindow';
type Pixels = Record<Capture, { changedPixels: number | null }>;

/** Same-run pixel dependency, never a product repair or reference-match claim. */
export function classifyNativePlacementEffect(
  valid: boolean,
  values: {
    baseline: Pixels | null;
    transform: Pixels | null;
    layout: Pixels | null;
    returned: Pixels | null;
    mechanism: Pixels | null;
  },
  exactReturn: Record<Capture, boolean>,
) {
  const capture = (kind: Capture) => {
    const counts = {
      baseline: values.baseline?.[kind].changedPixels ?? null,
      transform: values.transform?.[kind].changedPixels ?? null,
      layout: values.layout?.[kind].changedPixels ?? null,
      returned: values.returned?.[kind].changedPixels ?? null,
      mechanism: values.mechanism?.[kind].changedPixels ?? null,
    };
    const missing = Object.values(counts).some(
      (n) => n === null || !Number.isInteger(n) || n < 0,
    );
    const status =
      !valid ||
      missing ||
      !exactReturn[kind] ||
      counts.returned !== counts.transform ||
      (counts.mechanism === 0 && counts.transform !== counts.layout)
        ? 'invalid-experiment'
        : counts.mechanism === 0
          ? 'no-observable-effect'
          : counts.baseline === 0
            ? 'not-supported'
            : 'supported';
    return {
      status,
      ...counts,
      exactReturn: exactReturn[kind],
      mechanismPixelsDiffer: counts.mechanism !== null && counts.mechanism > 0,
      currentBaselineHasResidual:
        counts.baseline !== null && counts.baseline > 0,
    };
  };
  const captures = {
    formalElement: capture('formalElement'),
    fullFramePanelWindow: capture('fullFramePanelWindow'),
  };
  const statuses = Object.values(captures).map((item) => item.status);
  const status = statuses.includes('invalid-experiment')
    ? 'invalid-experiment'
    : statuses.every((value) => value === 'supported')
      ? 'supported'
      : statuses.every((value) => value === 'no-observable-effect')
        ? 'no-observable-effect'
        : 'not-supported';
  return {
    status,
    captures,
    supportsSameRunNativePixelDependency: status === 'supported',
    provesProductRepair: false,
  };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = (message: string): never => {
  throw Error('Invalid native placement experiment: ' + message);
};

// The empty stylesheet must leave the existing app and all its ancestors exact.
export function placementRootIdentity(
  before: PanelsCausalSnapshot,
  attached: PanelsCausalSnapshot,
) {
  if (!same(before.ancestors, attached.ancestors))
    fail('ancestor identity, geometry or paint changed during attachment');
  const body = before.ancestors.find((node) => node.tag === 'BODY');
  const roots = before.ancestors.filter(
    (node) => node.parentIdentity === body?.identity,
  );
  if (!body || roots.length !== 1 || roots[0]!.tag !== 'DIV')
    fail('native application root identity missing');
  return roots[0]!.identity;
}

/** Fixed viewport coordinates: only this host's known transform matrix differs.
 * Every ancestor box, clip/paint field, identity and state otherwise stays exact. */
export function assertPlacementAncestors(
  transform: PanelsCausalSnapshot,
  layout: PanelsCausalSnapshot,
  placementIdentity: number,
  offset: { x: number; y: number },
) {
  const allowed = [
    'matrix(1, 0, 0, 1, 0, 0)',
    `matrix(1, 0, 0, 1, ${offset.x}, ${offset.y})`,
  ];
  const normalized = (value: PanelsCausalSnapshot) => {
    const roots = value.ancestors.filter(
      (node) => node.identity === placementIdentity,
    );
    if (roots.length !== 1) fail('owned ancestor identity lost');
    if (!allowed.includes(roots[0]!.styles.transform!))
      fail('unplanned host transform');
    return value.ancestors.map((node) =>
      node.identity === placementIdentity
        ? {
            ...node,
            styles: { ...node.styles, transform: '<owned placement matrix>' },
          }
        : node,
    );
  };
  if (!same(normalized(transform), normalized(layout)))
    fail('fixed-origin ancestor geometry/clip/paint/state changed');
}
