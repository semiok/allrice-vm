import { createHash } from 'node:crypto';
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
      readImmutableBundle: (reference: string) =>
        bundle(two.registry, reference),
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
      await expect(
        holdReleasedProfile(
          directory,
          {
            ...current,
            async readImmutableBundle(reference) {
              const value = await current.readImmutableBundle(reference);
              return reference === corrupt
                ? Buffer.concat([Buffer.from('x'), value])
                : value;
            },
          },
          lifetime,
        ),
      ).rejects.toThrow('D entry native owner is not bound');
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
  } finally {
    for (const context of contexts.reverse()) await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
