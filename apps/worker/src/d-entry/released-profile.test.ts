import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  deferred,
  hostFixture,
  issue,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { createDEntryPrincipalControl } from './principal-control.js';
import { DEntryProfileGraphSchema } from '@allrice/contracts';
import { expect, it, vi } from 'vitest';
import { holdReleasedProfile } from './released-profile.js';

const authStage = vi.hoisted(() => ({
  afterWrite: undefined as ((filename: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>();
  return {
    ...fs,
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      await fs.writeFile(...args);
      if (typeof args[0] === 'string') await authStage.afterWrite?.(args[0]);
    },
  };
});

async function observerFixture(options?: {
  loader?: boolean;
  graphEvents?: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'allrice-observer-'));
  const local = await hostFixture(issue('execute'), true, null);
  const lifetime = new AbortController().signal;
  const control = createDEntryPrincipalControl(local.node, {
    carrier: lifetime,
    cleanupTimeoutMs: 3000,
  });
  const owner = await import(
    new URL('../../dsh/allrice-native-web-owner.mjs', import.meta.url).href
  );
  const artifacts = join(directory, 'guest-auth.json');
  const install = createRequire(
    new URL(
      '../../../../packages/dsh-web-composition/package.json',
      import.meta.url,
    ),
  );
  const native = await import(
    pathToFileURL(install.resolve('@deepseek-ai/dsh-client-modules')).href
  );
  let loader;
  if (options?.loader) {
    const fromBoot = createRequire(
      install.resolve('@deepseek-ai/dsh-app-boot'),
    );
    const plugin = await import(
      pathToFileURL(fromBoot.resolve('@deepseek-ai/cordis-plugin-loader')).href
    );
    await local.host.plugin(plugin.default);
    loader = local.host.get('loader');
  } else local.host.provide('loader', { entries: () => [] });
  const callbacks = new Set<() => void>();
  if (options?.graphEvents) {
    local.host.provide('clientModules', {
      graph: () => ({ rev: 'fixture-current-graph' }),
      onGraphChanged(listener: () => void) {
        callbacks.add(listener);
        return () => {
          callbacks.delete(listener);
        };
      },
    });
  } else await local.host.plugin(native.ClientModuleRegistry);
  const mount = (nonce: string, entered?: () => void) =>
    local.host.plugin({
      inject: ['allricePrincipal', 'connection', 'clientModules'],
      apply(ctx: Context) {
        const applying = owner.apply(ctx, {
          artifactPath: artifacts,
          nonce,
          baseUrl: 'http://127.0.0.1:18881/',
        });
        entered?.();
        return applying;
      },
    });
  return {
    directory,
    local,
    owner,
    artifacts,
    mount,
    loader,
    graphChanged() {
      for (const callback of callbacks) callback();
    },
    async open(scopeId = randomUUID()) {
      return control
        .acquire({ ...local.selected, scopeId }, lifetime)
        .run(lifetime);
    },
    async close() {
      await Promise.allSettled([control.close()]);
      await local.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('keeps the first graph withdrawal terminal failure after its scope leaves the Host', async () => {
  const f = await observerFixture({ graphEvents: true });
  const writingClosed = deferred();
  const finishWrite = deferred();
  const broken = Error('old control downlink refused the terminal item');
  try {
    const previous = f.mount('graph-owner');
    await previous;
    const wire = f.local.host.typertGateway.wireStream;
    const open = wire.open.bind(wire);
    let first = true;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await open(...args);
      if (args[0] !== 'allricePrincipal/openScope' || !first) return source;
      first = false;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const row of source) {
            if (Reflect.get(row as object, 'type') === 'closed') {
              writingClosed.resolve();
              await finishWrite.promise;
              throw broken;
            }
            yield row;
          }
        },
      };
    });
    const scopeId = randomUUID();
    const page = await f.open(scopeId);
    const service = f.local.host.allricePrincipal;
    const terminal = [...service['scopeControls']][0]!;
    const rightFailure = terminal.catch((error: unknown) => error);
    f.graphChanged();
    await writingClosed.promise;
    expect(page.revoked.aborted).toBe(true);
    expect(service.scopes.has(scopeId)).toBe(false);
    finishWrite.resolve();
    const original = await rightFailure;
    expect(original).toBeInstanceOf(Error);
    expect(service['scopeControls'].size).toBe(0);
    await expect(f.owner.unloadNativeWebOwner(previous)).rejects.toBe(original);
    const successor = f.mount('cannot-overtake-failed-control');
    await expect(successor.await()).rejects.toBe(original);
    await expect(f.open()).rejects.toBeDefined();
  } finally {
    finishWrite.resolve();
    await f.close();
  }
});

it('retains the real staging removal failure even when disposal canceled publication', async () => {
  const f = await observerFixture();
  const staging = deferred<string>();
  const release = deferred();
  try {
    authStage.afterWrite = async (filename) => {
      if (!filename.startsWith(f.artifacts + '.')) return;
      staging.resolve(filename);
      await release.promise;
    };
    const owner = f.mount('staging-cleanup-failure');
    const temporary = await staging.promise;
    await rm(temporary);
    await mkdir(temporary);
    const stopped = f.owner.unloadNativeWebOwner(owner);
    void stopped.catch(() => {});
    await expect(f.open()).rejects.toBeDefined();
    release.resolve();
    const error = await stopped.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'ERR_FS_EISDIR', path: temporary });
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const successor = f.mount('staged-owner-failure-successor');
    await expect(successor.await()).rejects.toBe(error);
    await expect(f.open()).rejects.toBeDefined();
  } finally {
    release.resolve();
    authStage.afterWrite = undefined;
    await f.close();
  }
});

it('replaces a real Cordis loader entry updated during auth staging without publishing its old nonce', async () => {
  const f = await observerFixture({ loader: true });
  const neighbor = await hostFixture();
  const signal = new AbortController().signal;
  const control = createDEntryPrincipalControl(neighbor.node, {
    carrier: signal,
    cleanupTimeoutMs: 3000,
  });
  const staging = deferred();
  const release = deferred();
  const newArtifact = join(f.directory, 'replacement-auth.json');
  try {
    const other = await control.acquire(neighbor.selected, signal).run(signal);
    const loader = f.loader!;
    loader.builtins['observer-test-owner'] = {
      inject: ['allricePrincipal', 'connection', 'clientModules'],
      apply: f.owner.apply,
    };
    authStage.afterWrite = async (filename) => {
      if (!filename.startsWith(f.artifacts + '.')) return;
      staging.resolve();
      await release.promise;
    };
    const baseUrl = 'http://127.0.0.1:18881/';
    const id = await loader.create({
      name: 'cordis:observer-test-owner',
      config: { artifactPath: f.artifacts, nonce: 'old', baseUrl },
    });
    const entry = loader.resolve(id)!;
    const exactFiber = entry.fiber!;
    await staging.promise;
    await entry.update({
      config: { artifactPath: newArtifact, nonce: 'new', baseUrl },
    });
    expect(entry.fiber).toBe(exactFiber);
    await expect(f.open()).rejects.toBeDefined();
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(other.revoked.aborted).toBe(false);
    release.resolve();
    await expect
      .poll(async () => {
        const value = await readFile(newArtifact, 'utf8').catch(
          () => undefined,
        );
        return value === undefined ? undefined : JSON.parse(value).nonce;
      })
      .toBe('new');
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(entry.fiber).toBe(exactFiber);
    expect((await f.open()).opened.baseline.owner).toBe(false);
    expect(other.revoked.aborted).toBe(false);
    await f.owner.unloadNativeWebOwner(exactFiber);
  } finally {
    release.resolve();
    authStage.afterWrite = undefined;
    await Promise.allSettled([f.close(), control.close()]);
    await neighbor.close();
  }
});

it('retirement waits for the real old control downlink and a disposed waiter cannot publish', async () => {
  const f = await observerFixture();
  const neighbor = await hostFixture();
  const signal = new AbortController().signal;
  const other = createDEntryPrincipalControl(neighbor.node, {
    carrier: signal,
    cleanupTimeoutMs: 3000,
  });
  const firstDelivery = deferred();
  const finishDelivery = deferred();
  const finalDelivery = deferred();
  const finishFinal = deferred();
  try {
    const previous = f.mount('first-owner');
    await previous;
    const scopeId = randomUUID();
    const wire = f.local.host.typertGateway.wireStream;
    const open = wire.open.bind(wire);
    let watched = false;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await open(...args);
      if (args[0] !== 'allricePrincipal/openScope' || watched) return source;
      watched = true;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const row of source) {
            if (Reflect.get(row as object, 'type') === 'revoked') {
              firstDelivery.resolve();
              await finishDelivery.promise;
            }
            if (Reflect.get(row as object, 'type') === 'closed') {
              finalDelivery.resolve();
              await finishFinal.promise;
            }
            yield row;
          }
        },
      };
    });
    const opened = await f.open(scopeId);
    const unaffected = await other
      .acquire(neighbor.selected, signal)
      .run(signal);
    let retired = false;
    const stopping = f.owner.unloadNativeWebOwner(previous).then(() => {
      retired = true;
    });
    void stopping.catch(() => {});
    await firstDelivery.promise;
    await expect
      .poll(() => f.local.host.allricePrincipal.scopes.has(scopeId))
      .toBe(false);
    expect(opened.revoked.aborted).toBe(false);
    expect(retired).toBe(false);

    const loading = deferred();
    const canceled = f.mount('canceled-owner', loading.resolve);
    await loading.promise;
    const disposedWhileLoading = canceled.dispose();
    await expect(f.open()).rejects.toBeDefined();
    const ready = deferred();
    const successor = f.mount('successor', ready.resolve);
    await ready.promise;
    let restarted = false;
    void Promise.resolve(successor).then(
      () => {
        restarted = true;
      },
      () => {},
    );
    expect(restarted).toBe(false);
    expect(unaffected.revoked.aborted).toBe(false);

    finishDelivery.resolve();
    await finalDelivery.promise;
    await expect.poll(() => opened.revoked.aborted).toBe(true);
    expect(retired).toBe(false);
    expect(restarted).toBe(false);
    await expect(f.open()).rejects.toBeDefined();
    finishFinal.resolve();
    await stopping;
    await disposedWhileLoading;
    await successor;
    expect(JSON.parse(await readFile(f.artifacts, 'utf8')).nonce).toBe(
      'successor',
    );
    expect((await f.open()).opened.baseline.owner).toBe(false);
    expect(unaffected.revoked.aborted).toBe(false);
    await f.owner.unloadNativeWebOwner(successor);
  } finally {
    finishDelivery.resolve();
    finishFinal.resolve();
    await Promise.allSettled([other.close(), f.close()]);
    await neighbor.close();
  }
});

it('a Cordis owner disposed during actual local auth staging issues no scope and commits no nonce', async () => {
  const f = await observerFixture();
  const staging = deferred();
  const finish = deferred();
  try {
    authStage.afterWrite = async (filename) => {
      if (!filename.startsWith(f.artifacts + '.')) return;
      staging.resolve();
      await finish.promise;
    };
    const loading = f.mount('staged-but-disposed');
    await staging.promise;
    // The actual staging write returned from the filesystem while the rename
    // and enablement remain governed by this Cordis activation.
    const disposing = loading.dispose();
    await expect(f.open()).rejects.toBeDefined();
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    finish.resolve();
    await disposing;
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(f.open()).rejects.toBeDefined();
    const fresh = f.mount('next-owner');
    await fresh;
    expect(JSON.parse(await readFile(f.artifacts, 'utf8')).nonce).toBe(
      'next-owner',
    );
    expect((await f.open()).opened.baseline.owner).toBe(false);
    await f.owner.unloadNativeWebOwner(fresh);
  } finally {
    finish.resolve();
    authStage.afterWrite = undefined;
    await f.close();
  }
});

it('returns the real local retirement failure to an explicit unloader and keeps the same Host closed', async () => {
  const f = await observerFixture();
  try {
    const previous = f.mount('owner-with-failing-cleanup');
    await previous;
    await rm(f.artifacts);
    await mkdir(f.artifacts);
    await expect(f.owner.unloadNativeWebOwner(previous)).rejects.toMatchObject({
      code: 'ERR_FS_EISDIR',
      path: f.artifacts,
    });
    const successor = f.mount('must-not-issue');
    await expect(successor.await()).rejects.toMatchObject({
      code: 'ERR_FS_EISDIR',
      path: f.artifacts,
    });
    await expect(f.open()).rejects.toBeDefined();
  } finally {
    await f.close();
  }
});

it('attests each exact resource in independent rc.2 graph orders and rejects a modified bundle, map or URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-native-profile-copies-'));
  const install = createRequire(
    new URL(
      '../../../../packages/dsh-web-composition/package.json',
      import.meta.url,
    ),
  );
  const api = await import(
    pathToFileURL(install.resolve('@deepseek-ai/dsh-client-modules')).href
  );
  const names = [
    '@deepseek-ai/dsh-client-modules',
    '@allrice/dsh-web-composition',
    '@allrice/independent-profile-module',
    '@allrice/dependent-profile-module',
  ];
  type Registry = {
    graph(): ReturnType<typeof DEntryProfileGraphSchema.parse>;
    fetchBundle(request: Request): Promise<Response>;
    onGraphChanged(listener: () => void): () => void;
    rebuilt(id: string): string | undefined;
  };
  const contexts: Context[] = [];
  async function installed(name: string, mtime: number, reverse = false) {
    const directory = join(root, name);
    const entries = await Promise.all(
      names.map(async (name, index) => {
        const pkg = join(directory, name);
        await mkdir(pkg, { recursive: true });
        const entry = join(pkg, 'host.js');
        await writeFile(entry, 'export function apply() {}\n');
        await writeFile(
          join(pkg, 'client.js'),
          ('globalThis.nativeTestBundle = ' + index + ';\n').repeat(index + 1),
        );
        const { utimes } = await import('node:fs/promises');
        await utimes(join(pkg, 'client.js'), mtime, mtime);
        await writeFile(
          join(pkg, 'package.json'),
          JSON.stringify({
            name,
            type: 'module',
            exports: { '.': './host.js', './client': './client.js' },
            dsh: {
              client: {
                platform: 'web',
                immediately: index === 0,
                ...(index === 3 && { external: [names[1]] }),
              },
            },
          }),
        );
        return {
          options: { name: pathToFileURL(entry).href },
          fiber: {},
          disabled: false,
          parent: { tree: { ctx: { baseUrl: pathToFileURL(entry).href } } },
        };
      }),
    );
    const context = new Context();
    contexts.push(context);
    context.provide('loader', {
      entries: () => (reverse ? [...entries].reverse() : entries),
    } as unknown as Context['loader']);
    await context.plugin(api.ClientModuleRegistry);
    const registry = context.get('clientModules') as Registry;
    return { directory, registry };
  }
  async function bundle(registry: Registry, reference: string) {
    const reply = await registry.fetchBundle(
      new Request('http://localhost/' + reference),
    );
    expect(reply.ok).toBe(true);
    return Buffer.from(await reply.arrayBuffer());
  }
  const lifetime = new AbortController().signal;
  try {
    const one = await installed('authoritative-release', 1_000_000);
    const two = await installed('native-guest-install', 2_000_000, true);
    const nativeFile = (directory: string) =>
      join(directory, names[0]!, 'client.js');
    const a = await stat(nativeFile(one.directory));
    const b = await stat(nativeFile(two.directory));
    expect(a.ino).not.toBe(b.ino);
    expect(a.ctimeMs).not.toBe(b.ctimeMs);
    expect(await readFile(nativeFile(one.directory))).toEqual(
      await readFile(nativeFile(two.directory)),
    );
    const graph = DEntryProfileGraphSchema.parse(one.registry.graph());
    const native = DEntryProfileGraphSchema.parse(two.registry.graph());
    expect(native.rev).not.toBe(graph.rev);
    expect(native.entries.map(({ id }) => id)).not.toEqual(
      graph.entries.map(({ id }) => id),
    );
    expect(native.batches[1]!.entries).not.toEqual(graph.batches[1]!.entries);
    const directory = join(root, 'sealed');
    const files: Array<{ path: string; bytes: number; sha256: string }> = [];
    async function seal(path: string, data: Buffer) {
      const descriptor = {
        path,
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), data);
      files.push(descriptor);
      return descriptor;
    }
    for (const name of [
      'managed/employee-web-entry.js',
      'managed/employee-web-entry.css',
      'native/assets/index-CN7NIWNw.js',
      'native/assets/vendor-DcuzkuQH.js',
      'native/assets/vendor-DV2921Zo.css',
      'native/assets/index-BxpfOGf3.css',
    ])
      await seal(name, Buffer.from('/* fixture static resource */'));
    const proofs = [];
    for (const resource of [...graph.entries, ...graph.batches]) {
      for (const reference of [
        resource.url,
        resource.url.replaceAll('/client.js', '/client.js.map'),
      ])
        proofs.push({
          reference,
          ...(await seal(
            'plugins/' +
              createHash('sha256').update(reference).digest('hex') +
              (reference === resource.url ? '.js' : '.map'),
            await bundle(one.registry, reference),
          )),
        });
    }
    await writeFile(
      join(directory, 'artifact.json'),
      JSON.stringify({
        format: 1,
        status: 'code-artifacts-only',
        source: { dirty: false },
        nativeRelease: {
          name: '@deepseek-ai/dsh-web-frontend',
          version: '0.2.1-rc.2',
        },
        closure: {
          publicNativeDist: true,
          sourceBuiltContribution: true,
          profileScripts: true,
          managedEntry: true,
        },
        managedEntry: 'managed/employee-web-entry.js',
        files,
        profile: {
          graph,
          bootInjections: api.bootInjections(graph),
          files: proofs,
          sourceBuiltClient: true,
        },
      }),
    );
    const current = {
      revoked: lifetime,
      async readImmutableGraph() {
        return native;
      },
      async readImmutableBundle(reference: string, bytes: number) {
        const value = await bundle(two.registry, reference);
        expect(bytes).toBe(value.byteLength);
        return value;
      },
    };
    const serving = await holdReleasedProfile(directory, current, lifetime);
    expect(serving.graph).toEqual(native);
    for (const { url, rev } of [...native.entries, ...native.batches]) {
      expect((await serving.readReference(url, rev, lifetime)).data).toEqual(
        await bundle(two.registry, url),
      );
    }
    const superseded = graph.entries[0]!;
    await expect(
      serving.readReference(superseded.url, superseded.rev, lifetime),
    ).rejects.toThrow('not_found');
    const target = native.entries[0]!;
    for (const corrupt of [
      target.url,
      target.url.replaceAll('/client.js', '/client.js.map'),
    ]) {
      const requested: string[] = [];
      await expect(
        holdReleasedProfile(
          directory,
          {
            ...current,
            async readImmutableBundle(reference, bytes) {
              requested.push(reference);
              const value = await current.readImmutableBundle(reference, bytes);
              if (reference !== corrupt) return value;
              const changed = Buffer.from(value);
              changed[0] = changed[0]! ^ 1;
              expect(changed.byteLength).toBe(bytes);
              return changed;
            },
          },
          lifetime,
        ),
      ).rejects.toThrow('D entry native owner is not bound');
      if (corrupt === target.url) expect(requested).toEqual([target.url]);
    }
    await expect(
      holdReleasedProfile(
        directory,
        {
          ...current,
          async readImmutableGraph() {
            return {
              ...native,
              entries: native.entries.map((row, index) =>
                index === 0 ? { ...row, url: row.url + '&extra=1' } : row,
              ),
            };
          },
        },
        lifetime,
      ),
    ).rejects.toThrow('D entry native owner is not bound');

    const local = await hostFixture(issue('execute'), true, null);
    const neighbor = await hostFixture(issue('execute'));
    const control = createDEntryPrincipalControl(local.node, {
      carrier: lifetime,
      cleanupTimeoutMs: 3000,
    });
    const otherControl = createDEntryPrincipalControl(neighbor.node, {
      carrier: lifetime,
      cleanupTimeoutMs: 3000,
    });
    const owner = await import(
      new URL('../../dsh/allrice-native-web-owner.mjs', import.meta.url).href
    );
    const artifactPath = join(root, 'guest-auth.json');
    local.host.provide('clientModules', {
      graph: () => two.registry.graph(),
      onGraphChanged: (listener: () => void) =>
        two.registry.onGraphChanged(listener),
    });
    const installOwner = (started?: () => void) =>
      local.host.plugin({
        inject: ['allricePrincipal', 'connection', 'clientModules'],
        apply(ctx: Context) {
          const loading = owner.apply(ctx, {
            artifactPath,
            nonce: randomUUID(),
            baseUrl: 'http://127.0.0.1:18881/',
          });
          started?.();
          return loading;
        },
      });
    const firstOwner = installOwner();
    const release = deferred();
    let nextOwner: ReturnType<typeof installOwner> | undefined;
    try {
      await firstOwner;
      const original = control.acquire(local.selected, lifetime);
      const page = await original.run(lifetime);
      const other = await otherControl
        .acquire(neighbor.selected, lifetime)
        .run(lifetime);
      const held = deferred();
      local.catalog.beforeList = async () => {
        held.resolve();
        await release.promise;
      };
      const call = {
        scopeId: local.selected.scopeId,
        endpoint: 'session/page' as const,
        args: {
          request: {
            address: { kind: 'session' as const, sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      };
      const reading = page.invoke(call, lifetime).then(
        () => false,
        () => true,
      );
      await held.promise;
      let ownerUnloaded = false;
      const unloading = owner.unloadNativeWebOwner(firstOwner).then(() => {
        ownerUnloaded = true;
      });
      await expect.poll(() => page.revoked.aborted).toBe(true);
      expect(ownerUnloaded).toBe(false);
      const nextIssue = () => ({ ...local.selected, scopeId: randomUUID() });
      await expect(
        control.acquire(nextIssue(), lifetime).run(lifetime),
      ).rejects.toBeDefined();
      await writeFile(
        nativeFile(two.directory),
        '/* a different native source generation */',
      );
      two.registry.rebuilt(names[0]!);
      expect(two.registry.graph().rev).not.toBe(native.rev);
      const replacing = deferred();
      nextOwner = installOwner(replacing.resolve);
      await replacing.promise;
      let replacementReady = false;
      void Promise.resolve(nextOwner).then(
        () => {
          replacementReady = true;
        },
        () => {},
      );
      await expect(
        control.acquire(nextIssue(), lifetime).run(lifetime),
      ).rejects.toBeDefined();
      expect(replacementReady).toBe(false);
      let joined = false;
      const closed = original.close().then(() => {
        joined = true;
      });
      expect(other.revoked.aborted).toBe(false);
      expect(local.catalog.pages).toHaveLength(0);
      expect(joined).toBe(false);
      release.resolve();
      expect(await reading).toBe(true);
      await closed;
      await unloading;
      await nextOwner;
      expect(joined).toBe(true);
      expect(ownerUnloaded).toBe(true);
      expect(replacementReady).toBe(true);
      expect(
        JSON.parse(await readFile(artifactPath, 'utf8')).nonce,
      ).toBeTruthy();
      local.catalog.beforeList = undefined;
      const fresh = nextIssue();
      const activity = control.acquire(fresh, lifetime);
      const reopened = await activity.run(lifetime);
      expect(
        (await reopened.invoke({ ...call, scopeId: fresh.scopeId }, lifetime))
          .value,
      ).toEqual({ records: [], hasMore: false });
      await writeFile(
        nativeFile(two.directory),
        '/* the registered owner observes this next source change */',
      );
      two.registry.rebuilt(names[0]!);
      await expect.poll(() => reopened.revoked.aborted).toBe(true);
      await activity.close();
      expect(
        (
          await other.invoke(
            { ...call, scopeId: neighbor.selected.scopeId },
            lifetime,
          )
        ).value,
      ).toEqual({ records: [], hasMore: false });
    } finally {
      release.resolve();
      await nextOwner?.dispose();
      await firstOwner.dispose();
      await Promise.all([control.close(), otherControl.close()]);
      await Promise.all([local.close(), neighbor.close()]);
    }
  } finally {
    for (const context of contexts.reverse()) await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
