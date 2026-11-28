import { expect, it } from 'vitest';
import { hasRootTitle, hasRootTitleSnapshot } from './native-title.js';

it('only reconciles the current native root on its title baseline or projection', () => {
  const title = {
    type: 'projection',
    sessionId: 'native-root',
    key: 'title',
    value: '生成标题',
    seq: 42,
  };
  const baseline = (id: string) => ({
    type: 'baseline',
    value: {
      projections: {
        [id]: { asOfSeq: 42, values: { title: '已有标题' } },
      },
    },
  });
  for (const frame of [title, baseline('native-root')])
    expect(hasRootTitle(frame, 'native-root')).toBe(true);
  for (const frame of [
    { ...title, sessionId: 'child' },
    { ...title, key: 'model' },
    { ...title, value: { title: 'invalid' } },
    baseline('another-root'),
    {
      type: 'baseline',
      value: { projections: { 'native-root': { values: {} } } },
    },
  ])
    expect(hasRootTitle(frame, 'native-root')).toBe(false);
});

it('recognizes a historical title in the opening snapshot only for the pinned root', () => {
  const snapshot = {
    type: 'snapshot',
    header: { id: 'native-root' },
    projections: { asOfSeq: 8, values: { title: '已有标题' } },
  };
  expect(hasRootTitleSnapshot(snapshot, 'native-root')).toBe(true);
  expect(hasRootTitleSnapshot(snapshot, 'child')).toBe(false);
  expect(
    hasRootTitleSnapshot(
      { ...snapshot, projections: { values: {} } },
      'native-root',
    ),
  ).toBe(false);
});
