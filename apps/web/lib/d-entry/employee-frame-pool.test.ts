import { describe, expect, it } from 'vitest';
import {
  emptyEmployeeFramePool,
  updateEmployeeFramePool,
} from './employee-frame-pool';

function journey() {
  let pool = emptyEmployeeFramePool();
  function select(employeeInstanceId: string, workspaceId = 'workspace') {
    pool = updateEmployeeFramePool(pool, {
      type: 'select',
      request: {
        query: employeeInstanceId,
        selection: { workspaceId, employeeInstanceId },
      },
    });
    return pool.frames.find(
      (frame) => frame.selection.employeeInstanceId === employeeInstanceId,
    );
  }
  function apply(action: Parameters<typeof updateEmployeeFramePool>[1]) {
    pool = updateEmployeeFramePool(pool, action);
  }
  function open(name: string) {
    const frame = select(name)!;
    apply({ type: 'ready', id: frame.id });
    return frame.id;
  }
  return {
    get pool() {
      return pool;
    },
    select,
    apply,
    open,
  };
}

describe('employee workbench frame pool', () => {
  it('promotes a ready frame synchronously and closes the least recent non-visible frame before opening another', () => {
    const state = journey();
    const a = state.open('a');
    const b = state.open('b');
    const c = state.open('c');
    expect(state.select('a')?.id).toBe(a);
    expect(state.pool.visible).toBe(a);
    expect(state.select('d')).toBeUndefined();
    expect(state.pool.frames.map(({ id, phase }) => [id, phase])).toEqual([
      [a, 'ready'],
      [b, 'closing'],
      [c, 'ready'],
    ]);
    state.apply({ type: 'joined', id: b, confirmed: true });
    const d = state.pool.frames.find((frame) => frame.query === 'd')!;
    expect(d.phase).toBe('opening');
    expect(state.pool.visible).toBe(a);
    state.apply({ type: 'ready', id: d.id });
    expect(state.pool.visible).toBe(d.id);
  });

  it('ignores late readiness when the user abandons a cold employee', () => {
    const state = journey();
    const a = state.open('a');
    const b = state.select('b')!.id;
    const c = state.select('c')!.id;
    state.apply({ type: 'ready', id: b });
    expect(state.pool.visible).toBe(a);
    expect(state.pool.frames.find(({ id }) => id === b)?.phase).toBe('closing');
    state.apply({ type: 'ready', id: c });
    expect(state.pool.visible).toBe(c);
  });

  it('immediately fences revoked and old-workspace frames and awaits joined proof', () => {
    const state = journey();
    const a = state.open('a');
    const b = state.open('b');
    state.apply({ type: 'invalidate', id: a });
    expect(state.pool.visible).toBe(b);
    expect(state.select('c', 'next-workspace')).toBeUndefined();
    expect(state.pool.visible).toBeUndefined();
    state.apply({ type: 'joined', id: a, confirmed: true });
    state.apply({ type: 'joined', id: b, confirmed: false });
    expect(state.pool.frames).toMatchObject([{ id: b, phase: 'unconfirmed' }]);
    expect(state.select('c', 'next-workspace')).toBeUndefined();
    state.apply({ type: 'reset' });
    expect(state.pool.wanted).toBeUndefined();
  });
});
