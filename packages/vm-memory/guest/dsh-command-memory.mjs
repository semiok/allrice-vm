import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'allrice-person-vm-command-memory';
export const inject = ['tools', 'shellEnv', 'sandboxPolicy'];

export const commandMemoryReady = Symbol.for(
  'allrice.person-vm-command-memory.ready',
);
const marker = 'DSH_ALLRICE_COMMAND_MEMORY_REF';
const state = '/run/allrice-command-memory';
const node = '/usr/local/bin/node';
const oomNotice = '命令组记录到 OOM，具体受影响进程尚未确认。请分批处理。';
const enterGroup = `
if [ "\${ALLRICE_MEMORY_MANAGED_RECEIPT_REF:-}" != "$ALLRICE_MEMORY_EXECUTION_REF" ]; then
  printf '%s\\n' 'COMMAND_MEMORY_SETUP_FAILED: 命令内存保护未就绪，本次命令未执行，会话保留' >&2
  exit 75
fi
unset BASH_ENV ALLRICE_MEMORY_DSH_DISPATCH ALLRICE_MEMORY_EXECUTION_REF ALLRICE_MEMORY_MANAGED_RECEIPT_REF
exec -- "$@"
`;

function invalidTrust() {
  throw new Error('COMMAND_MEMORY_TRUST_UNCONFIRMED');
}

function rootDirectory(path, privateMode = false) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== 0 ||
    realpathSync(path) !== path ||
    (privateMode ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)
  )
    invalidTrust();
}

function trustedEntrypoints(config) {
  const {
    controlDirectory,
    readonlyDshDirectory,
    cliPath,
    writer,
    guard,
    receiptDirectory,
  } = config;
  if (
    process.platform !== 'linux' ||
    process.getuid?.() !== 0 ||
    !/^\/opt\/allrice\/command-memory\/[a-f0-9]{64}$/.test(controlDirectory) ||
    !/^\/opt\/allrice\/dsh\/[a-f0-9]{64}$/.test(readonlyDshDirectory) ||
    writer !== join(controlDirectory, 'command-observer.cjs') ||
    guard !== join(controlDirectory, 'bash-env.sh') ||
    import.meta.url !==
      pathToFileURL(join(controlDirectory, 'dsh-command-memory.mjs')).href ||
    receiptDirectory !== join(state, 'receipts') ||
    realpathSync(process.execPath) !== node ||
    !Number.isSafeInteger(config.cleanupTimeoutMs) ||
    config.cleanupTimeoutMs <= 0 ||
    config.cleanupTimeoutMs > 2 ** 32 - 1
  )
    invalidTrust();
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [, , , , mount, flags] = line.split(' ');
      return { mount, readOnly: flags?.split(',').includes('ro') };
    });
  function verify(root, file) {
    const real = realpathSync(file);
    if (!real.startsWith(root + '/')) invalidTrust();
    const mount = mounts.filter(
      ({ mount }) =>
        mount === root ||
        (mount?.startsWith(root + '/') &&
          (real === mount || real.startsWith(mount + '/'))),
    );
    if (mount.length !== 1 || mount[0].mount !== root || !mount[0].readOnly)
      invalidTrust();
    return real;
  }
  for (const root of [controlDirectory, readonlyDshDirectory])
    for (let parent = dirname(root); parent !== '/'; parent = dirname(parent))
      rootDirectory(parent);
  verify(controlDirectory, writer);
  verify(controlDirectory, guard);
  verify(controlDirectory, join(controlDirectory, 'dsh-command-memory.mjs'));
  rootDirectory('/run');
  rootDirectory(state, true);
  rootDirectory(receiptDirectory, true);
  const require = createRequire(verify(readonlyDshDirectory, cliPath));
  return {
    require,
    subprocess: verify(
      readonlyDshDirectory,
      require.resolve('@deepseek-ai/dsh-subprocess-local'),
    ),
  };
}

/** Add a note to DSH's presentation. Native stream bytes, spill files and
 * cursors stay with the original subprocess and job owners. */
export function createCommandMemoryPresentation(ctx) {
  const calls = new WeakMap();
  const jobs = new Map();
  ctx.inject(['jobs'], (scoped) => {
    scoped.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'removed') jobs.delete(event.job.id);
    });
    scoped.effect(() => () => jobs.clear(), 'discard command memory job notes');
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (
      result.isError ||
      decision.kind !== 'accept' ||
      Object.hasOwn(decision, 'value')
    )
      return decision;
    const value = result.value;
    let observed;
    if (
      exec.name === 'bash' &&
      (value?.kind === 'foreground' || value?.kind === 'promoted')
    ) {
      observed = calls.has(exec.token);
    } else if (
      exec.name === 'job_output' &&
      value?.job?.kind === 'bash' &&
      ['completed', 'failed', 'killed'].includes(value.job.status) &&
      exec.agent
    ) {
      observed = jobs.get(value.job.id) === exec.agent.session;
    }
    const content = decision.content ?? result.content;
    if (!observed || content.length !== 1 || content[0].type !== 'text')
      return decision;
    return {
      ...decision,
      content: [{ ...content[0], text: `${oomNotice}\n${content[0].text}` }],
    };
  });
  return (dispatch, attempt) => {
    calls.set(dispatch.exec.token, true);
    if (!attempt.jobId || !dispatch.session) return;
    try {
      const job = ctx
        .get('jobs')
        ?.get(attempt.jobId, dispatch.session.header.id);
      if (job?.kind === 'bash' && job.owner === dispatch.session.header.id)
        jobs.set(attempt.jobId, dispatch.session);
    } catch {
      // The exact native job may already have been dropped.
    }
  };
}

/** Keep the receipt attached to the native quiescence observation even after
 * the tool returns. Disposal shares the same attempt and bounds its own wait. */
export function createCommandMemoryCleanup(cleanupTimeoutMs, report) {
  const owned = new Set();
  let closing;

  async function release(attempt, signal) {
    let outcome = null;
    let evidence;
    let released = false;
    try {
      outcome = await attempt.completed;
      if (attempt.handle && !attempt.joined) {
        attempt.joined = await attempt.handle.waitForExit(signal);
        if (attempt.joined !== true)
          throw new Error('native-subprocess-not-joined');
      }
      signal?.throwIfAborted();
      ({ released, evidence } = attempt.owner.release());
    } catch {
      evidence = { error: 'command-memory-cleanup-unconfirmed' };
    }
    if (released) owned.delete(attempt);
    report({
      ...attempt.call,
      jobId: attempt.jobId,
      executionRef: attempt.ref,
      outcome,
      released,
      evidence,
    });
  }

  function settle(attempt, signal) {
    attempt.pending ??= release(attempt, signal).finally(() => {
      attempt.pending = undefined;
    });
    return attempt.pending;
  }

  return {
    get closing() {
      return closing !== undefined;
    },
    track(attempt, onOom) {
      owned.add(attempt);
      attempt.completed =
        attempt.handle?.done.then(
          (outcome) => {
            try {
              const evidence = attempt.owner.observe();
              if (
                evidence?.receipt &&
                BigInt(evidence.after.oomKill) >
                  BigInt(evidence.receipt.baseline.oomKill)
              )
                onOom();
            } catch {
              // Evidence is optional for presentation; the native outcome stays intact.
            }
            return outcome;
          },
          () => null,
        ) ?? Promise.resolve(null);
      void settle(attempt).catch(() => {});
    },
    close() {
      return (closing ??= Promise.resolve().then(async () => {
        const signal = AbortSignal.timeout(cleanupTimeoutMs);
        const attempts = [...owned];
        const drained = Promise.allSettled(
          attempts.map(async (attempt) => {
            try {
              attempt.handle?.terminate();
            } catch {
              /* Only actual join can certify cleanup. */
            }
            await Promise.allSettled([attempt.pending]);
            if (owned.has(attempt) && !signal.aborted)
              await settle(attempt, signal);
          }),
        );
        const timeout = Promise.withResolvers();
        const listener = addAbortListener(signal, () => timeout.resolve());
        try {
          await Promise.race([drained, timeout.promise]);
        } finally {
          listener[Symbol.dispose]();
        }
        if (owned.size) throw new Error('COMMAND_MEMORY_CLEANUP_INCOMPLETE');
      }));
    },
  };
}

export async function apply(ctx, config) {
  const { require, subprocess } = trustedEntrypoints(config);
  const { LocalSubprocessRuntime } = await import(
    pathToFileURL(subprocess).href
  );
  const prepare = require(config.writer);
  if (typeof prepare !== 'function')
    throw new Error('COMMAND_MEMORY_VERIFIER_UNAVAILABLE');
  const active = new AsyncLocalStorage();
  const presentOom = createCommandMemoryPresentation(ctx);
  const cleanup = createCommandMemoryCleanup(
    config.cleanupTimeoutMs,
    (evidence) => {
      ctx.logger.info(`person-vm-command-memory ${JSON.stringify(evidence)}`);
    },
  );

  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== 'bash') return next();
    const dispatch = { exec, session: exec.agent?.session };
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
      const policy = ctx.sandboxPolicy.resolve(
        exec.agent && { session: exec.agent.session },
      );
      const mode = exec.arguments?.sandbox_permissions ?? policy.mode;
      if (mode === 'workspace-write') {
        const workspace = realpathSync(policy.workspaceRoot);
        if (
          workspace === '/' ||
          [
            state,
            '/opt/allrice',
            '/usr',
            '/bin',
            '/etc',
            '/lib',
            '/lib64',
            '/sys/fs/cgroup',
            '/proc',
          ].some(
            (path) =>
              workspace === path ||
              workspace.startsWith(path + '/') ||
              path.startsWith(workspace + '/'),
          )
        )
          invalidTrust();
      }
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
  new (class extends LocalSubprocessRuntime {
    get [commandMemoryReady]() {
      return true;
    }

    spawn(spec) {
      const ref = spec.env?.[marker];
      if (ref === undefined) return super.spawn(spec);
      const dispatch = active.getStore();
      const attempt = dispatch?.attempt;
      if (cleanup.closing || !attempt || attempt.ref !== ref || attempt.owner)
        throw new Error('COMMAND_MEMORY_DISPATCH_UNCONFIRMED');

      attempt.owner = prepare(ref);
      attempt.call = {
        callId: dispatch.exec.callId,
        rootCallId: dispatch.exec.rootCallId,
      };
      // Place the same process before the native runner applies Landlock or
      // enters bwrap's PID namespace. Turn over the exact argv by exec.
      const env = {
        ...spec.env,
        BASH_ENV: config.guard,
        ALLRICE_MEMORY_DSH_DISPATCH: '1',
        ALLRICE_MEMORY_EXECUTION_REF: ref,
      };
      delete env[marker];
      try {
        attempt.handle = super.spawn({
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
        return attempt.handle;
      } finally {
        // A synchronous native spawn throw precedes handle creation. Once a
        // handle exists only its actual close and range join permit release.
        cleanup.track(attempt, () => presentOom(dispatch, attempt));
      }
    }
  })(ctx);

  ctx.effect(() => cleanup.close, 'join person VM command observation');
}
