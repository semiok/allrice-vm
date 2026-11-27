/** Report phase durations without identity, session, artifact or RPC payloads. */
export function dEntryStartupTiming(operation: 'page-open' | 'editor-proof') {
  const startedAt = performance.now();
  const phases: Record<string, number> = {};
  let emitted = false;
  function emit(outcome: 'ready' | 'failed', failedPhase?: string) {
    if (emitted) return;
    emitted = true;
    try {
      console.info('[d-entry-startup-timing]', {
        operation,
        outcome,
        elapsedMs: Math.round(performance.now() - startedAt),
        phases: { ...phases },
        failedPhase,
      });
    } catch {
      // Telemetry cannot prevent cleanup or grant readiness.
    }
  }
  return {
    async run<T>(phase: string, read: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        const value = await read();
        phases[phase] = Math.round(performance.now() - start);
        return value;
      } catch (error) {
        phases[phase] = Math.round(performance.now() - start);
        emit('failed', phase);
        throw error;
      }
    },
    ready: () => emit('ready'),
  };
}
