import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { createWriteStream, constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { PersonVmTemplateManifestSchema } from '../../../packages/person-vm/src/template-snapshot-contract.ts';
import {
  checkCaptureReceipt,
  firstDayIndex,
  hashPattern,
  payloads,
  requireCapture,
  sha256,
} from './capture-contract.mjs';
import { verifyStagedTemplate } from './verify.mjs';

export async function readCaptureFile(path, consume) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    requireCapture(before.isFile(), 'expected a file');
    const result = await consume(file, before);
    const after = await lstat(path, { bigint: true });
    requireCapture(
      [
        'dev',
        'ino',
        'size',
        'mode',
        'uid',
        'nlink',
        'ctimeNs',
        'mtimeNs',
      ].every((key) => before[key] === after[key]),
      'source file changed',
    );
    return result;
  } finally {
    await file.close();
  }
}

export async function readSmallFile(path, limit = 256 * 1024) {
  return readCaptureFile(path, async (file, info) => {
    requireCapture(
      info.size > 0n && info.size <= BigInt(limit),
      'invalid metadata size',
    );
    return file.readFile();
  });
}

export async function inventoryFile(path, signal, destination, sourceUid) {
  return readCaptureFile(path, async (file, info) => {
    if (sourceUid !== undefined) requireSealedSource(info, sourceUid);
    requireCapture(
      info.size > 0n && info.size <= BigInt(Number.MAX_SAFE_INTEGER),
      'invalid payload size',
    );
    const hash = createHash('sha256');
    const source = file.createReadStream({ autoClose: false, signal });
    if (destination) {
      await pipeline(
        source,
        async function* (chunks) {
          for await (const chunk of chunks) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(destination, { flags: 'wx', mode: 0o444 }),
        { signal },
      );
    } else {
      for await (const chunk of source) hash.update(chunk);
    }
    return { sizeBytes: Number(info.size), sha256: hash.digest('hex') };
  });
}

function requireSealedSource(info, uid) {
  requireCapture(
    info.uid === BigInt(uid) &&
      info.nlink === 1n &&
      (info.mode & 0o7222n) === 0n,
    'unexpected captured file owner, link count or permissions',
  );
}

async function requireDirectory(path, privateDirectory) {
  const info = await lstat(path);
  requireCapture(
    isAbsolute(path) &&
      (await realpath(path)) === path &&
      info.isDirectory() &&
      (info.mode & (privateDirectory ? 0o7077 : 0o7022)) === 0 &&
      (!privateDirectory || info.uid === process.getuid()),
    'unexpected build directory owner, permissions or real path',
  );
  return info;
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** The approved receipt digest is supplied out of band by the capture reviewer.
 * A fixture seal stays identifiable in the signed manifest and first-day index. */
export async function sealTemplate({
  source,
  output,
  captureSha256,
  privateKey,
  expected,
  run,
  mode = 'linux',
  signal,
}) {
  requireCapture(
    mode === 'linux' || mode === 'fixture',
    'invalid capture mode',
  );
  requireCapture(
    privateKey?.type === 'private' &&
      privateKey.asymmetricKeyType === 'ed25519',
    'Ed25519 key required',
  );
  const sourceStat = await requireDirectory(source, false);
  const outputStat = await requireDirectory(output, true);
  requireCapture(
    source !== output &&
      !source.startsWith(output + '/') &&
      !output.startsWith(source + '/'),
    'source and publication directories overlap',
  );
  const sourceEntries = (await readdir(source)).sort();
  requireCapture(
    JSON.stringify(sourceEntries) ===
      JSON.stringify([...Object.keys(payloads), 'capture.json'].sort()),
    'unexpected trailing or missing capture file',
  );
  const receiptBytes = await readCaptureFile(
    join(source, 'capture.json'),
    async (file, info) => {
      requireSealedSource(info, sourceStat.uid);
      requireCapture(
        info.size > 0n && info.size <= 256n * 1024n,
        'invalid receipt size',
      );
      return file.readFile({ signal });
    },
  );
  requireCapture(
    hashPattern.test(captureSha256) && sha256(receiptBytes) === captureSha256,
    'capture receipt digest mismatch',
  );
  const capture = JSON.parse(receiptBytes.toString('utf8'));
  checkCaptureReceipt(capture, { expected, mode });
  const indexBytes = Buffer.from(
    JSON.stringify(firstDayIndex(run, receiptBytes, mode)),
  );
  const archiveEvidence = [
    ['capture.json', receiptBytes],
    ['first-day-index.json', indexBytes],
  ];
  const manifest = PersonVmTemplateManifestSchema.parse({
    version: 1,
    engine: 'microsandbox',
    engineVersion: capture.engineVersion,
    restoreProtocol: 1,
    platform: 'linux/arm64',
    host: capture.host,
    guest: capture.guest,
    inputs: capture.inputs,
    files: [...capture.files]
      .sort((left, right) => (left.path < right.path ? -1 : 1))
      .concat(
        archiveEvidence.map(([path, bytes]) => ({
          role: 'metadata',
          path,
          sha256: sha256(bytes),
          sizeBytes: bytes.length,
        })),
      ),
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha256 = sha256(manifestBytes);
  const templateDirectory = join(output, manifestSha256);
  const staged = await mkdtemp(join(output, '.pending-'));
  const seal = {
    enabled: true,
    mode: 'probe',
    engine: 'microsandbox',
    platform: 'linux/arm64',
    templateDirectory,
    manifestSha256,
  };
  const publicationLock = join(output, '.publish-' + manifestSha256);
  let locked = false;
  let placed = false;
  let published = false;
  try {
    for (const entry of capture.files) {
      const actual = await inventoryFile(
        join(source, entry.path),
        signal,
        join(staged, entry.path),
        sourceStat.uid,
      );
      requireCapture(
        actual.sizeBytes === entry.sizeBytes && actual.sha256 === entry.sha256,
        'captured payload changed',
      );
    }
    for (const [path, bytes] of archiveEvidence) {
      await writeFile(join(staged, path), bytes, { mode: 0o444, flag: 'wx' });
    }
    await writeFile(join(staged, 'manifest.json'), manifestBytes, {
      mode: 0o444,
      flag: 'wx',
    });
    await writeFile(
      join(staged, 'manifest.sig'),
      sign(null, manifestBytes, privateKey),
      { mode: 0o444, flag: 'wx' },
    );
    await chmod(staged, 0o555);
    await verifyStagedTemplate(staged, {
      seal,
      expected,
      publicKey: createPublicKey(privateKey),
      publisherUid: outputStat.uid,
      signal,
      captureMode: mode,
    });
    await mkdir(publicationLock, { mode: 0o700 });
    locked = true;
    const existing = await lstatIfPresent(templateDirectory);
    requireCapture(!existing, 'template digest already published');
    signal.throwIfAborted();
    // Darwin requires write permission on a renamed directory. The private
    // publication parent fences this transition. The verifier treats a writable
    // destination as unsealed until the single final chmod.
    await chmod(staged, 0o700);
    await rename(staged, templateDirectory);
    placed = true;
    await chmod(templateDirectory, 0o555);
    published = true;
    return { seal, manifest };
  } finally {
    if (placed && !published)
      await rm(templateDirectory, { recursive: true, force: true });
    if (locked) await rm(publicationLock, { recursive: true });
    const leftover = await lstatIfPresent(staged);
    if (leftover) await chmod(staged, 0o700);
    await rm(staged, { recursive: true, force: true });
  }
}

async function main([command, configPath, keyPath, ...extra]) {
  requireCapture(
    configPath && extra.length === 0,
    'usage: build.mjs capture CONFIG.json | seal CONFIG.json KEY.pem',
  );
  const config = JSON.parse(
    (await readSmallFile(resolve(configPath))).toString('utf8'),
  );
  const signal = globalThis.AbortSignal.timeout(45 * 60 * 1000);
  if (command === 'capture' && !keyPath) {
    const { captureTemplate } = await import('./capture.mjs');
    const result = await captureTemplate({ ...config, signal });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  requireCapture(
    command === 'seal' && keyPath,
    'expected a capture or seal command',
  );
  const privateKey = await readCaptureFile(
    resolve(keyPath),
    async (file, stat) => {
      requireCapture(
        stat.uid === BigInt(process.getuid()) &&
          (stat.mode & 0o7777n) === 0o600n &&
          stat.nlink === 1n &&
          stat.size > 0n &&
          stat.size <= 8192n,
        'invalid publisher key file',
      );
      const bytes = await file.readFile();
      try {
        return createPrivateKey(bytes);
      } finally {
        bytes.fill(0);
      }
    },
  );
  const { seal } = await sealTemplate({
    ...config,
    mode: 'linux',
    privateKey,
    signal,
  });
  process.stdout.write(JSON.stringify(seal) + '\n');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main(process.argv.slice(2)).catch((error) => {
    // Subprocess diagnostics may contain local paths or raw guest output.
    console.error(
      error.message.startsWith('Snapshot capture refused:')
        ? error.message
        : 'Snapshot build failed',
    );
    process.exitCode = 1;
  });
}
