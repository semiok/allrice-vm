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
import { expect, it } from 'vitest';
import { holdReleasedProfile } from './released-profile.js';

it('attests each exact graph resource from independently installed rc.2 bytes and fails closed on a modified bundle, map or URL', async () => {
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
  ];
  type Registry = {
    graph(): ReturnType<typeof DEntryProfileGraphSchema.parse>;
    fetchBundle(request: Request): Promise<Response>;
    onGraphChanged(listener: () => void): () => void;
    rebuilt(id: string): string | undefined;
  };
  const contexts: Context[] = [];
  async function installed(name: string, mtime: number) {
    const directory = join(root, name);
    const entries = await Promise.all(
      names.map(async (name, index) => {
        const pkg = join(directory, name);
        await mkdir(pkg, { recursive: true });
        const entry = join(pkg, 'host.js');
        await writeFile(entry, 'export function apply() {}\n');
        await writeFile(
          join(pkg, 'client.js'),
          'globalThis.nativeTestBundle = ' + index + ';\n',
        );
        const { utimes } = await import('node:fs/promises');
        await utimes(join(pkg, 'client.js'), mtime, mtime);
        await writeFile(
          join(pkg, 'package.json'),
          JSON.stringify({
            name,
            type: 'module',
            exports: { '.': './host.js', './client': './client.js' },
            dsh: { client: { platform: 'web', immediately: index === 0 } },
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
      entries: () => entries,
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
    const two = await installed('native-guest-install', 2_000_000);
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
              return reference === corrupt
                ? Buffer.concat([Buffer.from('x'), value])
                : value;
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
    const installOwner = (started?: () => void) =>
      local.host.plugin({
        apply(ctx: Context) {
          const loading = owner.apply(
            {
              effect: ctx.effect.bind(ctx),
              allricePrincipal: ctx.allricePrincipal,
              connection: ctx.connection,
              clientModules: two.registry,
            },
            {
              artifactPath,
              nonce: randomUUID(),
              baseUrl: 'http://127.0.0.1:18881/',
            },
          );
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
      const unloading = firstOwner.dispose().then(() => {
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
