import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  employeeProfileRuntime,
  loadBase,
  normalizeArchive,
  requireReadOnlyDisk,
  sha256,
  source,
  stageEmployeeProfileNativeInputs,
  withScratch,
} from './verify.mjs';

let temp;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'person-vm-image-test-'));
});
afterEach(() => rmSync(temp, { recursive: true }));

const regular = (path, data = 'node fixture', mode = 0o644) => ({
  path,
  mode,
  kind: 'file',
  data,
});
const directory = (path) => ({ path, mode: 0o755, kind: 'directory' });
const link = (path, target) => ({ path, mode: 0o777, kind: 'symlink', target });

function fixture(entries, declared = entries) {
  const input = join(temp, 'input.tar');
  const inventory = join(temp, 'inventory.json');
  const payload = join(temp, 'payload.tar');
  const layer = join(temp, 'layer.tar');
  execFileSync('python3', [
    '-I',
    '-c',
    String.raw`
import io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w', format=tarfile.PAX_FORMAT) as dest:
    for row in json.loads(sys.argv[2]):
        entry = tarfile.TarInfo(row['path'])
        entry.mode = row['mode']
        entry.uid, entry.gid = (501, 20)
        entry.mtime = row.get('mtime', 10)
        entry.pax_headers = row.get('pax', {})
        entry.type = {'file': tarfile.REGTYPE, 'directory': tarfile.DIRTYPE,
                      'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE}[row['kind']]
        entry.linkname = row.get('target', '')
        data = row.get('data', '').encode()
        entry.size = len(data)
        dest.addfile(entry, io.BytesIO(data) if entry.isfile() else None)
`,
    input,
    JSON.stringify(entries),
  ]);
  writeFileSync(
    inventory,
    JSON.stringify(
      declared.map(({ data, ...entry }) => ({
        ...entry,
        ...(data !== undefined
          ? { bytes: Buffer.byteLength(data), sha256: sha256(data) }
          : {}),
      })),
    ),
  );
  return { input, inventory, payload, layer };
}

function inspect(file) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-I',
        '-c',
        String.raw`
import json, sys, tarfile
with tarfile.open(sys.argv[1]) as src:
    print(json.dumps([[m.name, m.mode, m.uid, m.gid, m.mtime, m.linkname,
        src.extractfile(m).read().decode() if m.isfile() else None] for m in src]))
`,
        file,
      ],
      { encoding: 'utf8' },
    ),
  );
}

describe('offline payload', () => {
  it('preserves bytes and local links on both outputs, normalizes mode and owner', () => {
    const f = fixture([
      directory('lib'),
      regular('lib/über.js'),
      link('launch', 'lib/über.js'),
      regular('bwrap', 'fake ELF', 0o755),
    ]);
    normalizeArchive(
      f.input,
      f.inventory,
      f.payload,
      f.layer,
      'opt/sealed/runtime',
    );
    const payload = inspect(f.payload);
    const guestLayer = inspect(f.layer)
      .filter(([name]) => name.startsWith('opt/sealed/runtime/'))
      .map(([name, ...row]) => [
        name.slice('opt/sealed/runtime/'.length),
        ...row,
      ]);
    expect(guestLayer).toEqual(payload);
    expect(payload).toEqual([
      ['bwrap', 0o555, 0, 0, 946684800, '', 'fake ELF'],
      ['launch', 0o777, 0, 0, 946684800, 'lib/über.js', null],
      ['lib', 0o555, 0, 0, 946684800, '', null],
      ['lib/über.js', 0o444, 0, 0, 946684800, '', 'node fixture'],
    ]);
  });

  it('is byte stable across archive order and source timestamps', () => {
    const entries = [directory('lib'), regular('lib/index.js'), regular('a')];
    const a = fixture(entries);
    normalizeArchive(a.input, a.inventory, a.payload, a.layer);
    const expected = [
      sha256(readFileSync(a.payload)),
      sha256(readFileSync(a.layer)),
    ];
    const b = fixture(
      [...entries].reverse().map((entry) => ({ ...entry, mtime: 222 })),
    );
    normalizeArchive(b.input, b.inventory, b.payload, b.layer);
    expect([
      sha256(readFileSync(b.payload)),
      sha256(readFileSync(b.layer)),
    ]).toEqual(expected);
  });

  it.each([
    ['traversal', [regular('../secret')], /Unsafe or duplicate/],
    [
      'case collision',
      [regular('Case'), regular('case')],
      /Unsafe or duplicate/,
    ],
    ['environment', [regular('.env')], /Unsafe or duplicate/],
    ['token file', [regular('credentials.json')], /Unsafe or duplicate/],
    ['whiteout', [regular('.wh.old')], /Unsafe or duplicate/],
    [
      'escaping symlink',
      [link('outside', '../outside')],
      /declared local file/,
    ],
    ['absolute symlink', [link('outside', '/tmp/outside')], /Unsafe link/],
    ['symlink cycle', [link('cycle', 'cycle')], /declared local file/],
    [
      'missing directory in a symlink',
      [link('alias', 'missing/../plain'), regular('plain')],
      /declared local file/,
    ],
    [
      'setuid',
      [regular('unsafe', 'payload', 0o4755)],
      /Privileged archive metadata/,
    ],
    [
      'file capability',
      [
        {
          ...regular('unsafe'),
          pax: { 'SCHILY.xattr.security.capability': 'fixture' },
        },
      ],
      /Privileged archive metadata/,
    ],
    [
      'hardlink',
      [{ ...link('unsafe', 'plain'), kind: 'hardlink' }, regular('plain')],
      /Archive type/,
    ],
  ])('rejects %s', (_label, entries, reason) => {
    const f = fixture(entries);
    expect(() =>
      normalizeArchive(f.input, f.inventory, f.payload, f.layer),
    ).toThrow(reason);
  });

  it('rejects unlisted or changed archive content against the inventory', () => {
    for (const entries of [[regular('extra')], [regular('same', 'tampered')]]) {
      const f = fixture(entries, [regular('same', 'expected')]);
      expect(() =>
        normalizeArchive(f.input, f.inventory, f.payload, f.layer),
      ).toThrow(/Undeclared|mismatch/);
    }
  });
});

function baseFixture({ architecture = 'arm64', version = '22.23.2' } = {}) {
  const base = join(temp, 'base');
  mkdirSync(join(base, 'blobs', 'sha256'), { recursive: true });
  const put = (mediaType, body) => {
    const bytes = Buffer.from(body);
    const hex = sha256(bytes);
    const path = join(base, 'blobs', 'sha256', hex);
    writeFileSync(path, bytes);
    return {
      record: { mediaType, digest: 'sha256:' + hex, size: bytes.length },
      hex,
      path,
    };
  };
  const config = put(
    'application/vnd.oci.image.config.v1+json',
    JSON.stringify({
      os: 'linux',
      architecture,
      config: { Env: ['NODE_VERSION=' + version] },
      rootfs: { type: 'layers', diff_ids: ['sha256:' + 'a'.repeat(64)] },
    }),
  );
  const layer = put(
    'application/vnd.oci.image.layer.v1.tar+gzip',
    'compressed base layer fixture',
  );
  const mediaType = 'application/vnd.oci.image.manifest.v1+json';
  const manifest = put(
    mediaType,
    JSON.stringify({
      schemaVersion: 2,
      mediaType,
      config: config.record,
      layers: [layer.record],
    }),
  );
  return { base, manifest, layer };
}

describe('base OCI identity', () => {
  it('validates the exact manifest, config, version, descriptor digest and size', async () => {
    const f = baseFixture();
    const loaded = await loadBase(f.base, f.manifest.hex);
    expect([...loaded.layers.keys()]).toEqual([f.layer.hex]);
    writeFileSync(f.layer.path, Buffer.alloc(f.layer.record.size));
    await expect(loadBase(f.base, f.manifest.hex)).rejects.toThrow(
      /layer SHA-256 mismatch/,
    );
    writeFileSync(f.layer.path, '');
    await expect(loadBase(f.base, f.manifest.hex)).rejects.toThrow(
      /blob size or type/,
    );
  });

  it.each([{ architecture: 'amd64' }, { version: '22.0.0' }])(
    'rejects the wrong base %o',
    async (input) => {
      const f = baseFixture(input);
      await expect(loadBase(f.base, f.manifest.hex)).rejects.toThrow(
        /base platform, Node version/,
      );
    },
  );

  it('rejects a symlink in place of a manifest blob', async () => {
    const f = baseFixture();
    const outside = join(temp, 'not-a-blob');
    writeFileSync(outside, readFileSync(f.manifest.path));
    rmSync(f.manifest.path);
    symlinkSync(outside, f.manifest.path);
    await expect(loadBase(f.base, f.manifest.hex)).rejects.toThrow(
      /regular file/,
    );
  });
});

it('cleans only its scratch directory after a failure', async () => {
  await expect(
    withScratch(temp, (scratch) => {
      writeFileSync(join(scratch, 'partial'), 'fixture');
      throw new Error('first failure');
    }),
  ).rejects.toThrow('first failure');
  expect(execFileSync('/bin/ls', ['-A', temp], { encoding: 'utf8' })).toBe('');
});

it('rejects writable, hard-linked and symlinked runtime disk files', () => {
  const image = join(temp, 'runtime.ext4');
  const alias = join(temp, 'alias');
  writeFileSync(image, 'fixture', { mode: 0o444 });
  expect(requireReadOnlyDisk(image).size).toBe(7);
  chmodSync(image, 0o644);
  expect(() => requireReadOnlyDisk(image)).toThrow(/0444/);
  chmodSync(image, 0o444);
  linkSync(image, alias);
  expect(() => requireReadOnlyDisk(image)).toThrow(/one link/);
  rmSync(alias);
  symlinkSync(image, alias);
  expect(() => requireReadOnlyDisk(alias)).toThrow(/regular file/);
});

describe('Employee Web profile capture', () => {
  const native = {
    image: source.baseImage,
    readonlyDshDirectory: { artifactSha256: source.artifactSha256 },
    publicImageCache: { manifestSha256: '0'.repeat(64) },
    artifactChecksums: {
      binary: 'sha256:' + 'a'.repeat(64),
      libkrunfw: 'sha256:' + 'b'.repeat(64),
      agentd: 'sha256:' + 'c'.repeat(64),
    },
    readonlyDshRuntimeDisk: {
      diskSha256: '1'.repeat(64),
      candidateSha256: '2'.repeat(64),
      provision: 'disk',
    },
  };

  it('uses Linux only for disk provision and binds its exact disk and candidate', () => {
    expect(employeeProfileRuntime({})).toBeUndefined();
    expect(
      employeeProfileRuntime({
        ...native,
        readonlyDshRuntimeDisk: { provision: 'directory' },
      }),
    ).toBeUndefined();
    expect(employeeProfileRuntime(native)).toEqual({
      platform: 'linux/arm64',
      binding: 'eth0',
      diskSha256: native.readonlyDshRuntimeDisk.diskSha256,
      candidateSha256: native.readonlyDshRuntimeDisk.candidateSha256,
      cacheManifestSha256: native.publicImageCache.manifestSha256,
      nativeChecksums: native.artifactChecksums,
    });
    expect(
      employeeProfileRuntime({
        ...native,
        artifactChecksums: {
          ...native.artifactChecksums,
          agentd: 'sha256:' + 'd'.repeat(64),
        },
      }),
    ).not.toEqual(employeeProfileRuntime(native));
    expect(
      employeeProfileRuntime({
        ...native,
        publicImageCache: { manifestSha256: '9'.repeat(64) },
      }),
    ).not.toEqual(employeeProfileRuntime(native));
    expect(() =>
      employeeProfileRuntime({ ...native, publicImageCache: undefined }),
    ).toThrow('sealed offline runtime');
    expect(() =>
      employeeProfileRuntime({ ...native, readonlyDshRuntimeDisk: null }),
    ).toThrow('Invalid Employee Web disk provision');
  });

  it('stages only the expected native bytes and rejects changes and symbolic links', async () => {
    const input = join(temp, 'inputs');
    const output = join(temp, 'capture');
    const failed = join(temp, 'failed');
    mkdirSync(input);
    mkdirSync(output);
    mkdirSync(failed);
    const nativePaths = {
      binary: join(input, 'msb'),
      libkrunfw: join(input, 'firmware'),
      agentd: join(input, 'agent'),
    };
    const artifactChecksums = {};
    for (const [key, path] of Object.entries(nativePaths)) {
      writeFileSync(path, key);
      artifactChecksums[key] = 'sha256:' + sha256(key);
    }
    const config = { ...nativePaths, artifactChecksums };
    const signal = new globalThis.AbortController().signal;
    const staged = await stageEmployeeProfileNativeInputs(
      config,
      output,
      signal,
    );
    writeFileSync(nativePaths.agentd, 'changed');
    expect(readFileSync(staged.agentd, 'utf8')).toBe('agentd');
    await expect(
      stageEmployeeProfileNativeInputs(config, failed, signal),
    ).rejects.toThrow('checksum mismatch');
    const link = join(temp, 'link');
    const symlinkOutput = join(temp, 'symlink-output');
    mkdirSync(symlinkOutput);
    symlinkSync(nativePaths.binary, link);
    await expect(
      stageEmployeeProfileNativeInputs(
        { ...config, binary: link },
        symlinkOutput,
        signal,
      ),
    ).rejects.toMatchObject({ code: 'ELOOP' });
  });
});
