import { expect, it } from 'vitest';
import { hasRootTitle } from './native-title.js';

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
