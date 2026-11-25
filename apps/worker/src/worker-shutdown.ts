export interface WorkerShutdownTask {
  name: string;
  run(): unknown | Promise<unknown>;
}

/** Call admission fences synchronously, then retain the original rejection for
 * the final all-settled drain. A sync throw must not skip other owners. */
export function startWorkerShutdownTask(run: WorkerShutdownTask['run']) {
  let task: Promise<unknown>;
  try {
    task = Promise.resolve(run());
  } catch (error) {
    task = Promise.reject(error);
  }
  void task.catch(() => undefined);
  return task;
}

export class WorkerShutdownError extends AggregateError {
  readonly code = 'WORKER_SHUTDOWN_UNCONFIRMED';
  constructor(readonly failures: readonly { name: string; error: unknown }[]) {
    super(
      failures.map(({ error }) => error),
      'Worker shutdown remains unconfirmed',
    );
  }
}

/** A successful Host recovery can resolve its own failure and release the
 * pool held for that recovery. Other failed Worker owners still need proof. */
export function canFinishWorkerAfterModelRecovery(error: unknown) {
  return (
    error instanceof WorkerShutdownError &&
    error.failures.some(({ name }) => name === 'person_vm_host') &&
    error.failures.every(
      ({ name }) => name === 'person_vm_host' || name === 'database',
    )
  );
}

/** This drains existing owners; it neither kills processes nor invents a new
 * lifecycle. Dependent stages stay ordered even when a prior stage rejects. */
export async function closeWorkerResources(input: {
  drainTasks: readonly WorkerShutdownTask[];
  waitForProducerRoots(): Promise<unknown>;
  stopCloudProjects(): Promise<unknown>;
  closeHarness(): Promise<unknown>;
  waitForInventory(): Promise<unknown>;
  verifyRuntimeClosure(): Promise<unknown>;
  removeCapabilities(): Promise<unknown>;
  closeDatabase(failedStages: readonly string[]): Promise<unknown>;
}) {
  const failures: { name: string; error: unknown }[] = [];
  async function settle(tasks: readonly WorkerShutdownTask[]) {
    const results = await Promise.allSettled(
      tasks.map(({ run }) => startWorkerShutdownTask(run)),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected')
        failures.push({ name: tasks[i]!.name, error: result.reason });
    });
  }
  await settle(input.drainTasks);
  // In-flight claim/admission/retained children must settle before pool close.
  await settle([{ name: 'producer_roots', run: input.waitForProducerRoots }]);
  await settle([{ name: 'cloud_services', run: input.stopCloudProjects }]);
  await settle([{ name: 'harness', run: input.closeHarness }]);
  // A previously started heartbeat must not overwrite the final physical view.
  await settle([{ name: 'inventory_drain', run: input.waitForInventory }]);
  await settle([
    { name: 'runtime_close_readback', run: input.verifyRuntimeClosure },
  ]);
  await settle([
    { name: 'worker_capabilities', run: input.removeCapabilities },
  ]);
  await settle([
    {
      name: 'database',
      run: () => input.closeDatabase(failures.map(({ name }) => name)),
    },
  ]);
  if (failures.length) throw new WorkerShutdownError(failures);
}
