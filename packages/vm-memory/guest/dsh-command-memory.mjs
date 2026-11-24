import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'allrice-person-vm-command-memory';
export const inject = ['tools', 'shellEnv'];

export const commandMemoryReady = Symbol.for(
  'allrice.person-vm-command-memory.ready',
);
const marker = 'DSH_ALLRICE_COMMAND_MEMORY_REF';
const oomNotice = '命令组记录到 OOM，具体受影响进程尚未确认。请分批处理。';
const enterGroup = `
if [ "\${ALLRICE_MEMORY_MANAGED_RECEIPT_REF:-}" != "$ALLRICE_MEMORY_EXECUTION_REF" ]; then
  printf '%s\\n' 'COMMAND_MEMORY_SETUP_FAILED: 命令内存保护未就绪，本次命令未执行，会话保留' >&2
  exit 75
fi
unset BASH_ENV ALLRICE_MEMORY_EXECUTION_REF ALLRICE_MEMORY_MANAGED_RECEIPT_REF
exec -- "$@"
`;

export async function apply(ctx, config) {
  const require = createRequire(config.cliPath);
  const { LocalSubprocessRuntime } = await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess-local')).href
  );
  const complete = require(config.writer);
  if (typeof complete !== 'function')
    throw new Error('COMMAND_MEMORY_VERIFIER_UNAVAILABLE');
  const active = new AsyncLocalStorage();
  const byToken = new WeakMap();
  const observing = new Map();
  let closing = false;

  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== 'bash') return next();
    const dispatch = { exec, session: exec.agent?.session };
    byToken.set(exec.token, dispatch);
    return active.run(dispatch, next);
  });
  ctx.shellEnv.register({
    name,
    variables: {
      [marker]: { description: 'Managed shell execution reference' },
    },
    resolve(exec) {
      if (exec.name !== 'bash') return {};
      const dispatch = active.getStore();
      if (dispatch?.exec.token !== exec.token)
        throw new Error('COMMAND_MEMORY_DISPATCH_UNCONFIRMED');
      dispatch.attempt = { ref: randomUUID(), jobId: null };
      return { [marker]: dispatch.attempt.ref };
    },
  });
  ctx.on('session/event', (session, event) => {
    const dispatch = active.getStore();
    if (
      event.type === 'job/registered' &&
      event.data.kind === 'bash' &&
      dispatch?.session === session &&
      dispatch.attempt &&
      event.data.owner === session.header.id &&
      event.data.toolCall?.callId === dispatch.exec.callId &&
      event.data.toolCall.rootCallId === dispatch.exec.rootCallId
    ) {
      dispatch.attempt.jobId = event.data.jobId;
    }
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const observation = byToken.get(exec.token)?.attempt?.observation;
    const decision = await next();
    if (
      !observation ||
      decision.kind !== 'accept' ||
      Object.hasOwn(decision, 'value') ||
      result.isError ||
      result.value?.kind !== 'foreground' ||
      result.value.timedOut ||
      result.value.aborted ||
      (result.value.exitCode !== 137 && result.value.signal !== 'SIGKILL') ||
      exec.signal.aborted
    )
      return decision;
    const cancelled = Promise.withResolvers();
    const listener = addAbortListener(exec.signal, () =>
      cancelled.resolve(false),
    );
    try {
      if (
        !(await Promise.race([observation, cancelled.promise])) ||
        exec.signal.aborted
      )
        return decision;
    } finally {
      listener[Symbol.dispose]();
    }
    return {
      ...decision,
      content: [
        ...(decision.content ?? result.content),
        { type: 'text', text: oomNotice },
      ],
    };
  });

  new (class extends LocalSubprocessRuntime {
    get [commandMemoryReady]() {
      return true;
    }

    spawn(spec) {
      const ref = spec.env?.[marker];
      if (ref === undefined) return super.spawn(spec);
      const dispatch = active.getStore();
      const attempt = dispatch?.attempt;
      if (closing || !attempt || attempt.ref !== ref || attempt.observation)
        throw new Error('COMMAND_MEMORY_DISPATCH_UNCONFIRMED');

      // Place the same process before the native runner applies Landlock or
      // enters bwrap's PID namespace. Turn over the exact argv by exec.
      const env = {
        ...spec.env,
        BASH_ENV: config.guard,
        ALLRICE_MEMORY_EXECUTION_REF: ref,
      };
      delete env[marker];
      const handle = super.spawn({
        ...spec,
        env,
        argv: [
          '/bin/bash',
          '-c',
          enterGroup,
          'allrice-command-memory',
          ...spec.argv,
        ],
      });
      const observation = (async () => {
        const outcome = await handle.done.catch(() => null);
        let evidence;
        try {
          const joined = await handle.waitForExit(
            AbortSignal.timeout(config.cleanupTimeoutMs),
          );
          evidence = joined
            ? complete(ref)
            : { error: 'native-subprocess-not-joined' };
        } catch {
          evidence = { error: 'command-memory-observation-failed' };
        }
        const released =
          evidence?.childJoined === true && evidence.childReleased === true;
        const proof = released
          ? evidence
          : { error: 'command-memory-receipt-unconfirmed' };
        ctx.logger.info(
          `person-vm-command-memory ${JSON.stringify({
            callId: dispatch.exec.callId,
            rootCallId: dispatch.exec.rootCallId,
            jobId: attempt.jobId,
            executionRef: ref,
            outcome,
            evidence: proof,
          })}`,
        );
        return (
          released &&
          BigInt(evidence.after.oomKill) >
            BigInt(evidence.receipt.baseline.oomKill)
        );
      })();
      observing.set(handle, observation);
      attempt.observation = observation.catch(() => false);
      void attempt.observation.then(() => observing.delete(handle));
      return handle;
    }
  })(ctx);

  ctx.effect(
    () => async () => {
      closing = true;
      const handles = [...observing];
      await Promise.allSettled(
        handles.map(async ([handle]) => handle.terminate()),
      );
      await Promise.allSettled(handles.map(([, observation]) => observation));
    },
    'join person VM command observation',
  );
}
