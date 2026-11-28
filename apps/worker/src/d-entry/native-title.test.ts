import { expect, it } from 'vitest';
import { controlTitleTargets, snapshotTitleTarget } from './native-title.js';

it('extracts target IDs only from native title baselines and updates', () => {
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
    expect(controlTitleTargets(frame)).toEqual(['native-root']);
  expect(controlTitleTargets({ ...title, sessionId: 'another-root' })).toEqual([
    'another-root',
  ]);
  for (const frame of [
    { ...title, key: 'model' },
    { ...title, value: { title: 'invalid' } },
    {
      type: 'baseline',
      value: { projections: { 'native-root': { values: {} } } },
    },
  ])
    expect(controlTitleTargets(frame)).toEqual([]);
});

it('extracts the historical title target from a native opening snapshot', () => {
  const snapshot = {
    type: 'snapshot',
    header: { id: 'native-root' },
    projections: { asOfSeq: 8, values: { title: '已有标题' } },
  };
  expect(snapshotTitleTarget(snapshot)).toBe('native-root');
  expect(
    snapshotTitleTarget({ ...snapshot, projections: { values: {} } }),
  ).toBeUndefined();
});
