import { createHash, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import {
  LinuxSnapshotConfigurationSchema,
  PersonVmTemplateManifestSchema,
} from '../../../packages/person-vm/src/template-snapshot-contract.ts';
import { checkCaptureReceipt, firstDayIndex } from './capture-contract.mjs';

const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const maxManifestBytes = 256 * 1024;

function requireEvidence(condition, reason) {
  if (!condition) throw new Error('Unverified snapshot template: ' + reason);
}

function unchanged(before, after) {
  return [
    'dev',
    'ino',
    'uid',
    'mode',
    'nlink',
    'size',
    'mtimeNs',
    'ctimeNs',
  ].every((key) => before[key] === after[key]);
}

function requireReadOnly(stat, publisherUid) {
  requireEvidence(
    stat.uid === BigInt(publisherUid) && (stat.mode & 0o7222n) === 0n,
    'unexpected owner or permissions',
  );
}

async function readSealedFile(path, publisherUid, signal, consume) {
  signal.throwIfAborted();
  const file = await open(path, flags);
  try {
    const before = await file.stat({ bigint: true });
    requireReadOnly(before, publisherUid);
    requireEvidence(
      before.isFile() && before.nlink === 1n,
      'expected one regular file',
    );
    const result = await consume(file, before.size);
    requireEvidence(
      unchanged(before, await file.stat({ bigint: true })) &&
        unchanged(before, await lstat(path, { bigint: true })),
      'file changed during verification',
    );
    return result;
  } finally {
    await file.close();
  }
}

/** Offline readback of a publisher-owned template. The compatibility values
 * come from trusted build inputs and host preflight, independently of the manifest.
 * A later restore needs its own live ownership and mount proof. */
export async function verifyTemplate(options) {
  return verifySealedDirectory(options);
}

/** A publisher stages the protected directory next to the final digest path,
 * so rename changes only the name, even on filesystems with strict .. ACLs. */
export async function verifyStagedTemplate(staged, options) {
  requireEvidence(
    dirname(staged) === dirname(options.seal.templateDirectory) &&
      basename(staged).startsWith('.pending-'),
    'unexpected staging path',
  );
  return verifySealedDirectory(options, staged);
}

async function verifySealedDirectory(
  { seal: rawSeal, publicKey, expected, publisherUid, signal, captureMode },
  staged,
) {
  const seal = LinuxSnapshotConfigurationSchema.parse(rawSeal);
  requireEvidence(seal.enabled, 'probe seal required');
  requireEvidence(
    publicKey?.type === 'public' && publicKey.asymmetricKeyType === 'ed25519',
    'Ed25519 publisher key required',
  );
  requireEvidence(
    Number.isSafeInteger(publisherUid) && publisherUid >= 0,
    'publisher UID required',
  );

  const root = staged ?? seal.templateDirectory;
  signal.throwIfAborted();
  requireEvidence((await realpath(root)) === root, 'unexpected real path');
  const rootStat = await lstat(root, { bigint: true });
  requireReadOnly(rootStat, publisherUid);
  requireEvidence(rootStat.isDirectory(), 'expected a template directory');
  const manifestBytes = await readSealedFile(
    join(root, 'manifest.json'),
    publisherUid,
    signal,
    async (file, size) => {
      requireEvidence(
        size > 0n && size <= BigInt(maxManifestBytes),
        'invalid manifest size',
      );
      return file.readFile({ signal });
    },
  );
  requireEvidence(
    createHash('sha256').update(manifestBytes).digest('hex') ===
      seal.manifestSha256,
    'manifest digest mismatch',
  );
  const signature = await readSealedFile(
    join(root, 'manifest.sig'),
    publisherUid,
    signal,
    async (file, size) => {
      requireEvidence(size === 64n, 'invalid signature size');
      return file.readFile({ signal });
    },
  );
  requireEvidence(
    verify(null, manifestBytes, publicKey, signature),
    'invalid signature',
  );
  const manifest = PersonVmTemplateManifestSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
  );
  requireEvidence(
    isDeepStrictEqual(manifest.host, expected.host) &&
      isDeepStrictEqual(manifest.guest, expected.guest) &&
      isDeepStrictEqual(manifest.inputs, expected.inputs) &&
      manifest.files.find((file) => file.role === 'device-topology')?.sha256 ===
        expected.deviceTopologySha256,
    'host, release inputs or device topology mismatch',
  );

  const files = new Map(manifest.files.map((file) => [file.path, file]));
  if (
    captureMode ||
    files.has('capture.json') ||
    files.has('first-day-index.json')
  ) {
    async function readEvidence(path) {
      const entry = files.get(path);
      requireEvidence(
        entry?.role === 'metadata',
        'missing signed capture evidence',
      );
      return readSealedFile(
        join(root, path),
        publisherUid,
        signal,
        async (file, size) => {
          requireEvidence(
            size === BigInt(entry.sizeBytes) &&
              size <= BigInt(maxManifestBytes),
            'invalid capture evidence size',
          );
          const bytes = await file.readFile({ signal });
          requireEvidence(
            createHash('sha256').update(bytes).digest('hex') === entry.sha256,
            'capture evidence digest mismatch',
          );
          return bytes;
        },
      );
    }
    const receiptBytes = await readEvidence('capture.json');
    const receipt = JSON.parse(receiptBytes);
    const index = JSON.parse(await readEvidence('first-day-index.json'));
    const mode = captureMode ?? 'linux';
    checkCaptureReceipt(receipt, { expected, mode });
    requireEvidence(
      isDeepStrictEqual(index, firstDayIndex(index.run, receiptBytes, mode)) &&
        files.size === receipt.files.length + 2 &&
        receipt.files.every((entry) =>
          isDeepStrictEqual(entry, files.get(entry.path)),
        ),
      'signed capture evidence does not match the template',
    );
  }
  const directories = new Set();
  for (const path of files.keys()) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join('/'));
    }
  }
  const seen = new Set();
  async function checkTree(relative, before) {
    signal.throwIfAborted();
    const directory = join(root, relative);
    requireReadOnly(before, publisherUid);
    requireEvidence(before.isDirectory(), 'expected an inventoried directory');
    for (const name of await readdir(directory)) {
      const path = join(relative, name);
      const resolved = join(root, path);
      if (path === 'manifest.json' || path === 'manifest.sig') continue;
      if (directories.has(path)) {
        await checkTree(path, await lstat(resolved, { bigint: true }));
        continue;
      }
      const entry = files.get(path);
      requireEvidence(entry, 'unlisted file or directory');
      await readSealedFile(
        resolved,
        publisherUid,
        signal,
        async (file, size) => {
          requireEvidence(
            size === BigInt(entry.sizeBytes),
            'file size mismatch',
          );
          const hash = createHash('sha256');
          for await (const chunk of file.createReadStream({
            autoClose: false,
            signal,
          })) {
            hash.update(chunk);
          }
          requireEvidence(
            hash.digest('hex') === entry.sha256,
            'file digest mismatch',
          );
        },
      );
      seen.add(path);
    }
    requireEvidence(
      unchanged(before, await lstat(directory, { bigint: true })),
      'directory changed during verification',
    );
  }
  await checkTree('', rootStat);
  requireEvidence(seen.size === files.size, 'missing inventoried file');
  requireEvidence(
    (await realpath(root)) === root,
    'template moved during verification',
  );
  signal.throwIfAborted();
  return { seal, manifest };
}
