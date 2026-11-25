import {
  constants,
  copyFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareCandidate, withScratch } from './verify.mjs';

export async function buildCandidate(base, release, output) {
  output = resolve(output);
  return withScratch(dirname(output), async (scratch) => {
    const candidate = await prepareCandidate(base, release, scratch);
    // Refuse existing paths, including empty directories and symlinks. A
    // completed receipt is written only after both candidate outputs exist.
    mkdirSync(output, { mode: 0o700 });
    const oci = join(output, 'oci');
    const blobs = join(oci, 'blobs', 'sha256');
    mkdirSync(blobs, { recursive: true });
    for (const [digest, bytes] of candidate.documents) {
      writeFileSync(join(blobs, digest), bytes, { flag: 'wx', mode: 0o444 });
    }
    for (const [digest, file] of candidate.layers) {
      copyFileSync(file, join(blobs, digest), constants.COPYFILE_EXCL);
    }
    for (const [name, bytes] of candidate.layout) {
      writeFileSync(join(oci, name), bytes, { flag: 'wx', mode: 0o444 });
    }
    renameSync(candidate.disk, join(output, 'runtime.ext4'));
    writeFileSync(join(output, 'candidate.json'), candidate.receipt, {
      flag: 'wx',
      mode: 0o444,
    });
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
        'Usage: node build.mjs BASE_OCI RELEASE_DIRECTORY NEW_OUTPUT',
      );
    process.stdout.write(await buildCandidate(...args));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
