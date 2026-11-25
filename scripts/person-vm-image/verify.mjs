import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

async function hashFile(file) {
  ensure(lstatSync(file).isFile(), 'Expected a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  }))
    hash.update(chunk);
  return hash.digest('hex');
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
        target = p.normpath(p.join(parent, target))
        require(target in rows and rows[target]['kind'] == 'file', 'Link must end at a declared local file: ' + name)
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

export async function verifyCandidate(base, release, output) {
  return withScratch(tmpdir(), async (scratch) => {
    inventoryAt(output, ['oci', 'runtime.ext4', 'candidate.json']);
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
    const disk = join(output, 'runtime.ext4');
    ensure(
      statSync(disk).size === statSync(candidate.disk).size &&
        (await hashFile(disk)) === JSON.parse(candidate.receipt).disk.sha256,
      'Runtime disk SHA-256 mismatch',
    );
    ensure(
      readRegular(join(output, 'candidate.json')).equals(candidate.receipt),
      'Candidate receipt does not match verified sources and outputs',
    );
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
