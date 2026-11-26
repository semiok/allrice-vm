import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const basePin =
  'af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2';
export const source = Object.freeze({
  baseImage: 'docker.io/library/node@sha256:' + basePin,
  nodeVersion: '22.23.2',
  dshVersion: '0.2.1-rc.2',
  descriptorSha256:
    'c445d4472b9e523b3a671102ec26576df36b05327b2d704b8cec1390b6b2d2d4',
  manifestSha256:
    '6f5832697bc55c9bb31badd3a76afdb45ae0289bcedf52c01d68fa116ff261ca',
  artifactSha256:
    '24b043342743f063f4dbacdffbf825d7bc82b20d519566ba093215f765286543',
  originalDshTarSha256:
    '306d3e314b50b7a369642de939fea21616f582bcbe7b74f2936a00c2240699b8',
  originalDshManifestSha256:
    '44973b86f10555e9cf1ae07c4376fa97801fb15eec56fdc35549582a8b4cdd6f',
  originalDshTreeSha256:
    'e18d3f608aeab12e19918eddd7846af1659530949303a94a58a4ba3f3b74f310',
  treeSha256:
    'b1c66947f6e9d4f4da0fbb2a3315223657f60e21e002b928d2f4f532b190e20b',
  bubblewrapVersion: '0.8.0-2+deb12u1',
  bubblewrapDebSha256:
    'd044ba1d7961d835669035fcd1e11121f1dc960a1a2e1c6489a93ea44e083557',
  bubblewrapElfSha256:
    'ff5add553bea12a45c18ebe6c67d3ed637052b869a1ca2fc5d74a6a2e8c5cce6',
  cli: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
  lock: 'package-lock.json',
});
const prefix = 'opt/allrice/dsh/' + source.artifactSha256;
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const layerType = 'application/vnd.oci.image.layer.v1.tar';
const epoch = 946684800;
const created = new Date(epoch * 1000).toISOString();
const e2fsVersion = '1.47.4';
const blocks = 393216; // 1.5 GiB, with room above the sealed distribution.
const env = { PATH: process.env.PATH, LC_ALL: 'C', TZ: 'UTC' };

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The runtime artifact itself is verified again by the production native
 * provider immediately before mounting it in the capture guest. */
export function employeeProfileRuntime(native) {
  const disk = native?.readonlyDshRuntimeDisk;
  if (disk === undefined || disk?.provision === 'directory') return undefined;
  ensure(disk?.provision === 'disk', 'Invalid Employee Web disk provision');
  const nativeChecksums = {
    binary: native.artifactChecksums?.binary,
    libkrunfw: native.artifactChecksums?.libkrunfw,
    agentd: native.artifactChecksums?.agentd,
  };
  ensure(
    /^[a-f0-9]{64}$/.test(native.publicImageCache?.manifestSha256) &&
      native.image === source.baseImage &&
      native.readonlyDshDirectory?.artifactSha256 === source.artifactSha256 &&
      /^[a-f0-9]{64}$/.test(disk.diskSha256) &&
      /^[a-f0-9]{64}$/.test(disk.candidateSha256) &&
      Object.values(nativeChecksums).every(
        (checksum) =>
          typeof checksum === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(checksum),
      ),
    'Employee Web capture requires the sealed offline runtime',
  );
  return Object.freeze({
    platform: 'linux/arm64',
    binding: 'eth0',
    diskSha256: disk.diskSha256,
    candidateSha256: disk.candidateSha256,
    cacheManifestSha256: native.publicImageCache.manifestSha256,
    nativeChecksums: Object.freeze(nativeChecksums),
  });
}

async function hashFile(file, signal) {
  ensure(lstatSync(file).isFile(), 'Expected a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    signal,
  }))
    hash.update(chunk);
  return hash.digest('hex');
}

// The release command executes only private snapshots of the configured
// native files, so replacing a source after validation cannot change the VM.
export async function stageEmployeeProfileNativeInputs(
  native,
  directory,
  signal,
) {
  const paths = {};
  for (const [key, name] of Object.entries({
    binary: 'msb',
    libkrunfw: 'libkrunfw.5.dylib',
    agentd: 'agentd-aarch64',
  })) {
    signal.throwIfAborted();
    const checksum = native.artifactChecksums?.[key];
    const input = native[key];
    ensure(
      typeof checksum === 'string' &&
        /^sha256:[a-f0-9]{64}$/.test(checksum) &&
        typeof input === 'string' &&
        isAbsolute(input),
      'Invalid Employee Web capture native artifact',
    );
    const output = join(directory, name);
    const file = await open(
      input,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      ensure(
        (await file.stat()).isFile(),
        'Expected a regular native artifact',
      );
      await pipeline(
        file.createReadStream({ autoClose: false }),
        createWriteStream(output, {
          flags: 'wx',
          mode: key === 'libkrunfw' ? 0o400 : 0o500,
        }),
        { signal },
      );
    } finally {
      await file.close();
    }
    ensure(
      'sha256:' + (await hashFile(output, signal)) === checksum,
      'Employee Web capture native artifact checksum mismatch',
    );
    paths[key] = output;
  }
  return paths;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function readRegular(file) {
  ensure(lstatSync(file).isFile(), 'Expected a regular file');
  return readFileSync(file, {
    flag: constants.O_RDONLY | constants.O_NOFOLLOW,
  });
}

function pinned(file, expected) {
  const bytes = readRegular(file);
  ensure(sha256(bytes) === expected, 'Pinned input SHA-256 mismatch');
  return bytes;
}

const json = (value) => Buffer.from(JSON.stringify(value) + '\n');
const descriptor = (mediaType, digest, size) => ({
  mediaType,
  digest: 'sha256:' + digest,
  size,
});

function tool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      command +
        ' failed (' +
        (result.status ?? result.signal) +
        ')\n' +
        result.stderr,
    );
  return result.stdout + result.stderr;
}

export async function withScratch(parent, step) {
  const scratch = mkdtempSync(join(parent, '.person-vm-image-'));
  try {
    return await step(scratch);
  } finally {
    rmSync(scratch, { recursive: true });
  }
}

// Python's PAX reader/writer preserves long UTF-8 names. No archive member is
// extracted to the build host. Both tar writers consume the same validated rows.
const normalizeProgram = String.raw`
import hashlib, json, posixpath as p, re, sys, tarfile, unicodedata
from pathlib import PurePosixPath
archive, inventory, payload, layer, prefix, epoch = sys.argv[1:]
def require(ok, reason):
    if not ok:
        raise ValueError(reason)
def safe(name):
    return name and not name.startswith('/') and '\\' not in name and all(
        part not in ('', '.', '..') and not any(ord(c) < 32 or ord(c) == 127 for c in part)
        for part in name.split('/'))
def blocked(name):
    return any(re.fullmatch(r'(?i)(\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.codex|\.dsh|credentials\.json|auth\.json|id_(?:rsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx)|\.wh\..*)', part)
        for part in name.split('/'))
with open(inventory, encoding='utf-8') as f:
    declared = json.load(f)
rows, normalized = {}, set()
for row in declared:
    name = row['path']
    folded = unicodedata.normalize('NFC', name).casefold()
    require(safe(name) and not blocked(name) and folded not in normalized and name not in rows,
            'Unsafe or duplicate inventory path: ' + name)
    normalized.add(folded)
    rows[name] = row
for name, row in rows.items():
    parent = p.dirname(name)
    require(not parent or (parent in rows and rows[parent]['kind'] == 'directory'), 'Invalid parent: ' + name)
    if row['kind'] == 'symlink':
        target = row['target']
        require(target and not target.startswith('/') and '\\' not in target, 'Unsafe link: ' + name)
        parts = parent.split('/') if parent else []
        for index, component in enumerate(target.split('/')):
            if component == '..':
                require(parts, 'Link must end at a declared local file: ' + name)
                parts.pop()
            else:
                require(component not in ('', '.'), 'Unsafe link: ' + name)
                parts.append(component)
                path = '/'.join(parts)
                kind = 'file' if index == len(target.split('/')) - 1 else 'directory'
                require(path in rows and rows[path]['kind'] == kind, 'Link must end at a declared local file: ' + name)
        require('/'.join(parts) in rows and rows['/'.join(parts)]['kind'] == 'file',
                'Link must end at a declared local file: ' + name)
def info(name, item=None):
    row = rows.get(name)
    result = tarfile.TarInfo(name)
    result.uid = result.gid = 0
    result.uname = result.gname = 'root'
    result.mtime = int(epoch)
    if item is None or row['kind'] == 'directory':
        result.type, result.mode = tarfile.DIRTYPE, 0o555
    elif row['kind'] == 'symlink':
        result.type, result.mode, result.linkname = tarfile.SYMTYPE, 0o777, item.linkname
    else:
        result.type, result.mode, result.size = tarfile.REGTYPE, 0o555 if item.mode & 0o111 else 0o444, item.size
    return result
with tarfile.open(archive, 'r:') as incoming, tarfile.open(payload, 'w', format=tarfile.PAX_FORMAT) as disk, tarfile.open(layer, 'w', format=tarfile.PAX_FORMAT) as oci:
    seen = {}
    for item in incoming:
        name = item.name.rstrip('/')
        require(name in rows and name not in seen, 'Undeclared or duplicate archive path: ' + name)
        row = rows[name]
        kind = 'file' if item.isfile() else 'directory' if item.isdir() else 'symlink' if item.issym() else None
        require(kind == row['kind'] and item.mode == row['mode'] and (item.uid, item.gid) in ((0, 0), (501, 20)),
                'Archive type, mode or owner mismatch: ' + name)
        require(not item.mode & 0o7000 and not any(
            k.startswith(('SCHILY.', 'LIBARCHIVE.', 'GNU.sparse.')) for k in item.pax_headers
        ), 'Privileged archive metadata: ' + name)
        if kind == 'symlink':
            require(item.linkname == row['target'], 'Unexpected link: ' + name)
        seen[name] = item
    require(len(seen) == len(rows), 'Missing archive entries')
    for parent in reversed(PurePosixPath(prefix).parents):
        if parent not in (PurePosixPath('.'), PurePosixPath('opt')):
            oci.addfile(info(parent.as_posix()))
    oci.addfile(info(prefix))
    for name in sorted(rows, key=lambda name: name.encode('utf-8')):
        item = seen[name]
        disk_item = info(name, item)
        layer_item = info(name, item)
        layer_item.name = prefix + '/' + name
        if item.isfile():
            require(item.size == rows[name]['bytes'], 'File size mismatch: ' + name)
            with incoming.extractfile(item) as member:
                digest = hashlib.sha256()
                for chunk in iter(lambda: member.read(1024 * 1024), b''):
                    digest.update(chunk)
                require(digest.hexdigest() == rows[name]['sha256'], 'File SHA-256 mismatch: ' + name)
                member.seek(0)
                disk.addfile(disk_item, member)
                member.seek(0)
                oci.addfile(layer_item, member)
        else:
            disk.addfile(disk_item)
            oci.addfile(layer_item)
`;

export function normalizeArchive(
  archive,
  inventory,
  payload,
  layer,
  guestPrefix = prefix,
) {
  tool('python3', [
    '-I',
    '-c',
    normalizeProgram,
    archive,
    inventory,
    payload,
    layer,
    guestPrefix,
    String(epoch),
  ]);
}

// With a pinned base we only inspect the loader, dependency directories and
// the Node executable. Copy bytes under flat local names; never follow a tar
// symlink or run a guest binary on the build host.
const abiProgram = String.raw`
import json, posixpath as p, re, sys, tarfile
from pathlib import Path
output, payload, *layers = sys.argv[1:]
root = Path(output)
names = {}
def next_file(name, member, archive):
    if member.issym():
        names[name] = p.normpath(p.join(p.dirname(name), member.linkname)).lstrip('/')
    elif member.isfile():
        filename = str(len(names)) + '-' + name.replace('/', '_')
        with archive.extractfile(member) as src:
            (root / filename).write_bytes(src.read())
        names[name] = '@' + filename
for layer in layers:
    with tarfile.open(layer, 'r:*') as archive:
        for item in archive:
            name = item.name.removeprefix('./').rstrip('/')
            if name == 'opt/allrice' or name.startswith('opt/allrice/'):
                raise ValueError('Pinned base overlaps candidate payload')
            if name == 'usr/local/bin/node' and (not item.isfile() or not item.mode & 0o111):
                raise ValueError('Pinned Node executable is missing or non-executable')
            if name in ('lib', 'usr/lib/ld-linux-aarch64.so.1', 'usr/local/bin/node') or re.fullmatch(r'usr/lib/aarch64-linux-gnu/[^/]+\.so(?:\.[\d.]+)?', name):
                if name in ('lib', 'usr/lib/ld-linux-aarch64.so.1', 'usr/local/bin/node') or name.rsplit('/', 1)[-1].startswith(
                    ('ld-linux-', 'libc.so', 'libcap.so', 'libselinux.so', 'libpcre2-8.so', 'libstdc++.so', 'libgcc_s.so', 'libm.so', 'libpthread.so', 'libdl.so', 'librt.so')):
                    next_file(name, item, archive)
with tarfile.open(payload, 'r:') as archive:
    next_file('sandbox-bin/bwrap', archive.getmember('sandbox-bin/bwrap'), archive)
print(json.dumps(names))
`;

function inspectElf(file) {
  const bytes = readRegular(file);
  ensure(
    bytes.length >= 64 &&
      bytes
        .subarray(0, 6)
        .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) &&
      [2, 3].includes(bytes.readUInt16LE(16)) &&
      bytes.readUInt16LE(18) === 183,
    'Runtime includes a non-ARM64 ELF',
  );
  const output = tool('llvm-objdump', ['-p', file]);
  const offset = output.match(/\bINTERP off\s+(0x[\da-f]+)\b/);
  const interpreter = offset
    ? bytes
        .subarray(Number(offset[1]), bytes.indexOf(0, Number(offset[1])))
        .toString()
    : null;
  const needed = Array.from(
    output.matchAll(/^\s+NEEDED\s+(\S+)/gm),
    (match) => match[1],
  );
  ensure(
    !/^\s+(?:RPATH|RUNPATH)\b/m.test(output),
    'Unexpected ELF library search override',
  );
  return { interpreter, needed };
}

function verifyAbi(scratch, payload, layers) {
  const paths = JSON.parse(
    tool('python3', ['-I', '-c', abiProgram, scratch, payload, ...layers]),
  );
  const library = 'usr/lib/aarch64-linux-gnu/';
  ensure(paths.lib === 'usr/lib', 'Unexpected base loader directory');
  const observed = new Map();
  function visit(path) {
    if (observed.has(path)) return;
    const filename = paths[path];
    ensure(
      typeof filename === 'string',
      'Missing pinned-base ABI input: ' + path,
    );
    if (!filename.startsWith('@')) {
      ensure(
        filename.startsWith(library) && paths[filename]?.startsWith('@'),
        'Invalid base library link',
      );
      return visit(filename);
    }
    const file = join(scratch, filename.slice(1));
    if (path === 'sandbox-bin/bwrap') pinned(file, source.bubblewrapElfSha256);
    const abi = inspectElf(file);
    observed.set(path, abi);
    if (abi.interpreter) {
      const expected = 'ld-linux-aarch64.so.1';
      ensure(
        abi.interpreter === '/lib/' + expected ||
          abi.interpreter === '/lib/aarch64-linux-gnu/' + expected,
        'Unexpected ARM64 interpreter',
      );
      visit(
        abi.interpreter === '/lib/' + expected
          ? 'usr/lib/' + expected
          : library + expected,
      );
    }
    for (const needed of abi.needed) visit(library + needed);
  }
  visit('sandbox-bin/bwrap');
  visit('usr/local/bin/node');
  ensure(
    observed.get('sandbox-bin/bwrap').interpreter &&
      observed.get('usr/local/bin/node').interpreter,
    'Missing ARM64 loader',
  );
  return Object.fromEntries(observed);
}

export async function loadBase(
  base,
  pin = basePin,
  nodeVersion = source.nodeVersion,
  scratch,
) {
  const dir = join(base, 'blobs', 'sha256');
  const manifest = JSON.parse(pinned(join(dir, pin), pin));
  ensure(
    manifest.schemaVersion === 2 &&
      manifest.mediaType === manifestType &&
      manifest.config.mediaType === configType,
    'Expected the pinned OCI manifest',
  );
  function resource(record) {
    ensure(
      /^sha256:[0-9a-f]{64}$/.test(record.digest) &&
        Number.isSafeInteger(record.size) &&
        record.size > 0,
      'Invalid OCI descriptor',
    );
    const digest = record.digest.slice(7);
    const file = join(dir, digest);
    const stat = lstatSync(file);
    ensure(
      stat.isFile() && stat.size === record.size,
      'Invalid OCI blob size or type',
    );
    return { digest, file };
  }
  const cfg = resource(manifest.config);
  const config = JSON.parse(pinned(cfg.file, cfg.digest));
  ensure(
    config.os === 'linux' &&
      config.architecture === 'arm64' &&
      config.config.Env.includes('NODE_VERSION=' + nodeVersion) &&
      config.rootfs.type === 'layers' &&
      config.rootfs.diff_ids.length === manifest.layers.length,
    'Unexpected OCI base platform, Node version or diff IDs',
  );
  const layers = new Map();
  for (const record of manifest.layers) {
    ensure(
      record.mediaType === layerType + '+gzip',
      'Unexpected base layer codec',
    );
    const { digest, file } = resource(record);
    const input = scratch ? join(scratch, digest) : file;
    if (scratch) copyFileSync(file, input, constants.COPYFILE_EXCL);
    ensure(
      (await hashFile(input)) === digest,
      'Base OCI layer SHA-256 mismatch',
    );
    layers.set(digest, input);
  }
  return { manifest, config, layers };
}

function fsImage(scratch, payload) {
  const disk = join(scratch, 'runtime.ext4');
  const conf = join(scratch, 'mke2fs.conf');
  writeFileSync(
    conf,
    '[defaults]\nbase_features = sparse_super,large_file,filetype,ext_attr,dir_index\n[fs_types]\next4 = {\nfeatures = extent,flex_bg,uninit_bg,dir_nlink,extra_isize\n}\n',
  );
  const imageEnv = {
    ...env,
    E2FSPROGS_FAKE_TIME: String(epoch),
    MKE2FS_CONFIG: conf,
  };
  for (const command of ['mke2fs', 'e2fsck'])
    ensure(
      tool(command, ['-V']).includes(' ' + e2fsVersion + ' '),
      'Use e2fsprogs ' + e2fsVersion,
    );
  const uuid = source.artifactSha256
    .slice(0, 32)
    .replace(/^(........)(....)(....)(....)/, '$1-$2-$3-$4-');
  tool(
    'mke2fs',
    [
      '-q',
      '-F',
      '-t',
      'ext4',
      '-b',
      '4096',
      '-I',
      '256',
      '-N',
      '98304',
      '-m',
      '0',
      '-U',
      uuid,
      '-L',
      'allrice-dsh',
      '-E',
      'root_owner=0:0,root_perms=0555,lazy_itable_init=0,hash_seed=' + uuid,
      '-d',
      payload,
      disk,
      String(blocks),
    ],
    { env: imageEnv },
  );
  tool('e2fsck', ['-f', '-n', disk], { env: imageEnv });
  chmodSync(disk, 0o444);
  return disk;
}

export async function prepareCandidate(base, release, scratch) {
  const recipe = readFileSync(new URL('./Dockerfile', import.meta.url));
  ensure(
    recipe.toString() ===
      'FROM ' +
        source.baseImage +
        '\nCOPY --chown=0:0 payload/ /' +
        prefix +
        '/\n',
    'Dockerfile and offline OCI recipe disagree',
  );
  const sealed = JSON.parse(
    pinned(join(release, 'descriptor.json'), source.descriptorSha256),
  );
  const files = JSON.parse(
    pinned(join(release, 'manifest.json'), source.manifestSha256),
  );
  ensure(
    sealed.artifactSha256 === source.artifactSha256 &&
      sealed.treeSha256 === source.treeSha256 &&
      sealed.manifestSha256 === source.manifestSha256 &&
      sealed.baseImage === source.baseImage &&
      sealed.dshVersion === source.dshVersion &&
      sealed.nodeVersion === source.nodeVersion &&
      sealed.originalDshTarSha256 === source.originalDshTarSha256 &&
      sealed.sandboxBackend.kind === 'bubblewrap' &&
      sealed.sandboxBackend.path === 'sandbox-bin/bwrap' &&
      sealed.sandboxBackend.mode === 0o555 &&
      sealed.sandboxBackend.architecture === 'arm64' &&
      sealed.sandboxBackend.packageVersion === source.bubblewrapVersion &&
      sealed.sandboxBackend.packageSha256 === source.bubblewrapDebSha256 &&
      sealed.sandboxBackend.sha256 === source.bubblewrapElfSha256 &&
      files.containsAuthFiles === false &&
      files.platform === 'linux-arm64-gnu',
    'Unexpected sealed release',
  );
  const archive = join(scratch, 'source.tar');
  ensure(
    lstatSync(join(release, 'artifact.tar')).isFile(),
    'Expected a regular release archive',
  );
  copyFileSync(join(release, 'artifact.tar'), archive, constants.COPYFILE_EXCL);
  ensure(
    statSync(archive).size === sealed.archiveBytes &&
      (await hashFile(archive)) === source.artifactSha256,
    'Release archive size or SHA-256 mismatch',
  );
  const inventory = join(scratch, 'inventory.json');
  writeFileSync(inventory, json(files.files));
  const payload = join(scratch, 'payload.tar');
  const layer = join(scratch, 'image-layer.tar');
  normalizeArchive(archive, inventory, payload, layer);
  const { manifest, config, layers } = await loadBase(
    base,
    basePin,
    source.nodeVersion,
    scratch,
  );
  const abi = verifyAbi(scratch, payload, [...layers.values()]);
  const disk = fsImage(scratch, payload);

  const delta = await hashFile(layer);
  const imageConfig = json({
    ...config,
    created,
    rootfs: {
      type: 'layers',
      diff_ids: [...config.rootfs.diff_ids, 'sha256:' + delta],
    },
    history: [
      ...config.history,
      { created, created_by: 'COPY sealed DSH and bwrap /' + prefix + '/' },
    ],
  });
  const configSha = sha256(imageConfig);
  const imageManifest = json({
    schemaVersion: 2,
    mediaType: manifestType,
    config: descriptor(configType, configSha, imageConfig.length),
    layers: [
      ...manifest.layers,
      descriptor(layerType, delta, statSync(layer).size),
    ],
  });
  const imageSha = sha256(imageManifest);
  layers.set(delta, layer);
  const index = json({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        ...descriptor(manifestType, imageSha, imageManifest.length),
        platform: { os: 'linux', architecture: 'arm64' },
        annotations: { 'org.opencontainers.image.ref.name': 'candidate' },
      },
    ],
  });
  const receipt = json({
    schemaVersion: 1,
    platform: 'linux/arm64',
    source,
    cliSha256: files.files.find((row) => row.path === source.cli).sha256,
    lockSha256: files.files.find((row) => row.path === source.lock).sha256,
    recipeSha256: sha256(recipe),
    guestDirectory: '/' + prefix,
    payloadTarSha256: await hashFile(payload),
    oci: {
      manifestDigest: 'sha256:' + imageSha,
      layerDigest: 'sha256:' + delta,
    },
    disk: {
      sha256: await hashFile(disk),
      bytes: statSync(disk).size,
      format: 'raw/ext4',
      e2fsprogs: e2fsVersion,
    },
    abi,
  });
  return {
    receipt,
    disk,
    payload,
    layers,
    documents: new Map([
      [configSha, imageConfig],
      [imageSha, imageManifest],
    ]),
    layout: new Map([
      ['oci-layout', json({ imageLayoutVersion: '1.0.0' })],
      ['index.json', index],
    ]),
  };
}

function inventoryAt(dir, entries) {
  ensure(
    lstatSync(dir).isDirectory() &&
      readdirSync(dir).sort().join('\n') === [...entries].sort().join('\n'),
    'Unexpected candidate inventory',
  );
}

export function requireReadOnlyDisk(file) {
  const stat = lstatSync(file);
  ensure(
    stat.isFile() &&
      stat.uid === process.getuid() &&
      stat.nlink === 1 &&
      (stat.mode & 0o7777) === 0o444,
    'Runtime disk must be an owner-controlled 0444 regular file with one link',
  );
  return stat;
}

// Read actual ext4 directory entries, including modes that rdump normalizes.
// rdump is used for content and link targets after the raw SHA-256 is checked.
const diskInventoryProgram = String.raw`
import re, stat, sys, tarfile
from pathlib import Path
payload, batch, operation = sys.argv[1:]
expected = {'/': (0o40555, ''), '/lost+found': (0o40700, '')}
with tarfile.open(payload) as source:
    for member in source:
        kind = stat.S_IFREG if member.isfile() else stat.S_IFDIR if member.isdir() else stat.S_IFLNK
        size = str(member.size) if member.isfile() else str(len(member.linkname.encode('utf-8'))) if member.issym() else ''
        expected['/' + member.name] = (kind | member.mode, size)
directories = {name for name, (mode, _) in expected.items() if stat.S_ISDIR(mode)}
if operation == 'commands':
    if any('"' in name for name in directories):
        raise ValueError('Unexpected quote in sealed directory name')
    Path(batch).write_text(''.join('ls -p "' + name + '"\n' for name in sorted(directories)), encoding='utf-8')
else:
    actual, listed, inodes = {}, set(), set()
    for line in sys.stdin.read().splitlines():
        if line.startswith('debugfs: ls -p '):
            match = re.fullmatch(r'debugfs: ls -p "(/[^"]*)"', line)
            if not match or match[1] not in directories or match[1] in listed:
                raise ValueError('Unexpected ext4 listing: ' + line)
            current = match[1]
            listed.add(current)
        elif line.startswith('/'):
            _, ino, mode, uid, gid, name, size, _ = line.split('/')
            if ino == '0' and not name or name == '..' or name == '.' and current != '/':
                continue
            path = '/' if name == '.' else current.rstrip('/') + '/' + name
            if ino == '0' or ino in inodes or path in actual or (uid, gid) != ('0', '0'):
                raise ValueError('Invalid ext4 inode identity: ' + path)
            inodes.add(ino)
            actual[path] = (int(mode, 8), size)
        elif line and not re.fullmatch(r'debugfs [0-9.]+ \(.*\)', line):
            raise ValueError('Cannot read ext4 directory: ' + line)
    if actual != expected or listed != directories:
        changed = next((name for name in actual.keys() | expected.keys() if actual.get(name) != expected.get(name)), '/')
        raise ValueError('Ext4 inode inventory differs from the payload: ' + changed)
`;

const diskContentProgram = String.raw`
import hashlib, os, stat, sys, tarfile
from pathlib import Path
payload, output, operation = sys.argv[1:]
root = Path(output)
if operation == 'cleanup':
    for path, _, _ in os.walk(root, followlinks=False):
        os.chmod(path, 0o700)
else:
    def digest(handle):
        result = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(chunk)
        return result.digest()
    with tarfile.open(payload) as source:
        for member in source:
            target = root / member.name
            mode = target.lstat().st_mode
            if member.isfile() and stat.S_ISREG(mode):
                with target.open('rb') as actual, source.extractfile(member) as original:
                    if digest(actual) == digest(original):
                        continue
            elif member.issym() and stat.S_ISLNK(mode) and os.readlink(target) == member.linkname:
                continue
            elif member.isdir() and stat.S_ISDIR(mode):
                continue
            raise ValueError('Ext4 file contents, type or link differ: ' + member.name)
`;

function readBackDisk(disk, payload, scratch) {
  ensure(
    tool('debugfs', ['-V']).includes(' ' + e2fsVersion + ' '),
    'Use e2fsprogs ' + e2fsVersion,
  );
  const batch = join(scratch, 'debugfs-list');
  tool('python3', [
    '-I',
    '-c',
    diskInventoryProgram,
    payload,
    batch,
    'commands',
  ]);
  const inventory = tool('debugfs', ['-f', batch, disk], {
    maxBuffer: 16 * 1024 * 1024,
  });
  tool('python3', ['-I', '-c', diskInventoryProgram, payload, batch, 'check'], {
    input: inventory,
  });
  const attributes = tool('debugfs', [
    '-R',
    'ea_list /sandbox-bin/bwrap',
    disk,
  ]);
  ensure(
    /^debugfs [0-9.]+ \(.*\)$/.test(attributes.trim()),
    'Unexpected attributes on the runtime bwrap inode',
  );
  const directory = join(scratch, 'runtime-tree');
  mkdirSync(directory, { mode: 0o700 });
  try {
    // Unprivileged debugfs cannot chown the copy to root; owners were
    // checked on the real inodes above, so only compare copied bytes/links.
    tool('debugfs', ['-R', 'rdump / .', disk], {
      cwd: directory,
      stdio: 'ignore',
    });
    tool('python3', [
      '-I',
      '-c',
      diskContentProgram,
      payload,
      directory,
      'check',
    ]);
  } finally {
    tool('python3', [
      '-I',
      '-c',
      diskContentProgram,
      payload,
      directory,
      'cleanup',
    ]);
  }
}

export async function verifyCandidate(base, release, output) {
  return withScratch(tmpdir(), async (scratch) => {
    inventoryAt(output, ['oci', 'runtime.ext4', 'candidate.json']);
    const disk = join(output, 'runtime.ext4');
    requireReadOnlyDisk(disk);
    const candidate = await prepareCandidate(base, release, scratch);
    const oci = join(output, 'oci');
    inventoryAt(oci, [...candidate.layout.keys(), 'blobs']);
    inventoryAt(join(oci, 'blobs'), ['sha256']);
    const blobs = join(oci, 'blobs', 'sha256');
    inventoryAt(blobs, [
      ...candidate.documents.keys(),
      ...candidate.layers.keys(),
    ]);
    for (const [name, bytes] of candidate.layout)
      ensure(
        readRegular(join(oci, name)).equals(bytes),
        'OCI layout metadata mismatch',
      );
    for (const [digest, bytes] of candidate.documents)
      ensure(
        readRegular(join(blobs, digest)).equals(bytes),
        'OCI config or manifest mismatch',
      );
    for (const digest of candidate.layers.keys())
      ensure(
        (await hashFile(join(blobs, digest))) === digest,
        'OCI layer SHA-256 mismatch',
      );
    const readback = join(scratch, 'readback.ext4');
    const { size } = requireReadOnlyDisk(disk);
    copyFileSync(disk, readback, constants.COPYFILE_EXCL);
    ensure(
      size === statSync(candidate.disk).size &&
        (await hashFile(readback)) ===
          JSON.parse(candidate.receipt).disk.sha256,
      'Runtime disk SHA-256 mismatch',
    );
    ensure(
      readRegular(join(output, 'candidate.json')).equals(candidate.receipt),
      'Candidate receipt does not match verified sources and outputs',
    );
    readBackDisk(readback, candidate.payload, scratch);
    return candidate.receipt;
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 3)
      throw new Error(
        'Usage: node verify.mjs BASE_OCI RELEASE_DIRECTORY CANDIDATE',
      );
    process.stdout.write(await verifyCandidate(...args));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
