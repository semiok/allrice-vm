import type { DEntrySelectionInput } from '@allrice/contracts';

export const employeeFrameLimit = 3;

type EmployeeFrameRequest = {
  selection: DEntrySelectionInput;
  query: string;
};

type FramePhase = 'opening' | 'ready' | 'closing' | 'unconfirmed';

export type EmployeeFrame = EmployeeFrameRequest & {
  id: number;
  phase: FramePhase;
  lastUsed: number;
};

export type EmployeeFramePool = {
  frames: readonly EmployeeFrame[];
  visible?: number;
  wanted?: EmployeeFrameRequest;
  sequence: number;
};

export function emptyEmployeeFramePool(): EmployeeFramePool {
  return { frames: [], sequence: 0 };
}

type FrameAction =
  | { type: 'select'; request: EmployeeFrameRequest }
  | { type: 'ready'; id: number }
  | { type: 'invalidate'; id: number }
  | { type: 'joined'; id: number; confirmed: boolean }
  | { type: 'reset' };

function sameEmployee(a: EmployeeFrameRequest, b: EmployeeFrameRequest) {
  return (
    a.selection.workspaceId === b.selection.workspaceId &&
    a.selection.employeeInstanceId === b.selection.employeeInstanceId
  );
}

function changePhase(frame: EmployeeFrame, phase: FramePhase): EmployeeFrame {
  return frame.phase === phase ? frame : { ...frame, phase };
}

function closeFrame(frame: EmployeeFrame) {
  return frame.phase === 'unconfirmed' ? frame : changePhase(frame, 'closing');
}

function advance(pool: EmployeeFramePool): EmployeeFramePool {
  const wanted = pool.wanted;
  if (!wanted) return pool;
  if (
    pool.frames.some(
      (frame) => frame.selection.workspaceId !== wanted.selection.workspaceId,
    )
  )
    return {
      ...pool,
      visible: undefined,
      frames: pool.frames.map(closeFrame),
    };

  const frames = pool.frames.map((frame) =>
    frame.phase === 'opening' &&
    (!sameEmployee(frame, wanted) ||
      frame.selection.threadId !== wanted.selection.threadId)
      ? closeFrame(frame)
      : frame,
  );
  const found = frames.find((frame) => sameEmployee(frame, wanted));
  if (found) {
    if (found.phase !== 'ready') return { ...pool, frames };
    const sequence = pool.sequence + 1;
    return {
      frames: frames.map((frame) =>
        frame.id === found.id ? { ...frame, lastUsed: sequence } : frame,
      ),
      sequence,
      visible: found.id,
      wanted: undefined,
    };
  }
  if (frames.length >= employeeFrameLimit) {
    if (frames.some((frame) => frame.phase === 'closing'))
      return { ...pool, frames };
    let oldest: EmployeeFrame | undefined;
    for (const frame of frames)
      if (
        frame.id !== pool.visible &&
        frame.phase === 'ready' &&
        (!oldest || frame.lastUsed < oldest.lastUsed)
      )
        oldest = frame;
    return {
      ...pool,
      frames: frames.map((frame) =>
        frame.id === oldest?.id ? closeFrame(frame) : frame,
      ),
    };
  }
  const id = pool.sequence + 1;
  return {
    ...pool,
    sequence: id,
    frames: [...frames, { ...wanted, id, lastUsed: id, phase: 'opening' }],
  };
}

/** Closing/unconfirmed frames reserve capacity and cannot become visible again. */
export function updateEmployeeFramePool(
  pool: EmployeeFramePool,
  action: FrameAction,
): EmployeeFramePool {
  if (action.type === 'select')
    return advance({ ...pool, wanted: action.request });
  if (action.type === 'reset')
    return { sequence: pool.sequence, frames: pool.frames.map(closeFrame) };

  const frame = pool.frames.find(({ id }) => id === action.id);
  if (!frame) return pool;
  if (action.type === 'ready') {
    if (frame.phase !== 'opening') return pool;
    return advance({
      ...pool,
      frames: pool.frames.map((entry) =>
        entry === frame ? changePhase(entry, 'ready') : entry,
      ),
    });
  }
  if (action.type === 'invalidate')
    return advance({
      ...pool,
      visible: pool.visible === frame.id ? undefined : pool.visible,
      wanted:
        pool.wanted && sameEmployee(frame, pool.wanted)
          ? undefined
          : pool.wanted,
      frames: pool.frames.map((entry) =>
        entry === frame ? closeFrame(entry) : entry,
      ),
    });
  if (frame.phase !== 'closing') return pool;
  return advance({
    ...pool,
    frames: action.confirmed
      ? pool.frames.filter((entry) => entry !== frame)
      : pool.frames.map((entry) =>
          entry === frame ? changePhase(entry, 'unconfirmed') : entry,
        ),
  });
}
