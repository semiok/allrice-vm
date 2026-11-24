import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  buildEmployeeWebArtifact,
  publishEmployeeWebArtifact,
} from '../build-web-entry.mjs';

it('refuses to overwrite a previous release before launching a build or replacing bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'employee-web-immutable-'));
  try {
    // Codec fixture for immutable publication, never a runtime owner/graph.
    await writeFile(join(directory, 'artifact.json'), '{"original":true}');
    await writeFile(join(directory, 'client.js'), 'original release bytes');
    await expect(buildEmployeeWebArtifact(directory)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(join(directory, 'artifact.json'), 'utf8')).toBe(
      '{"original":true}',
    );
    expect(await readFile(join(directory, 'client.js'), 'utf8')).toBe(
      'original release bytes',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('replaces the default reference only after a whole build and allows a failed build to retry', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'employee-web-publish-'));
  const destination = join(parent, 'web-entry');
  const build = (version: string) => async (directory: string) => {
    await mkdir(directory);
    await writeFile(join(directory, 'artifact.json'), version);
    return { version } as Awaited<ReturnType<typeof buildEmployeeWebArtifact>>;
  };
  try {
    await build('legacy release')(destination);
    await publishEmployeeWebArtifact(
      destination,
      build('complete first release'),
    );
    await expect(
      publishEmployeeWebArtifact(destination, async (directory) => {
        await build('partial failed release')(directory);
        throw Error('build failed before publication');
      }),
    ).rejects.toThrow('build failed before publication');
    expect(await readFile(join(destination, 'artifact.json'), 'utf8')).toBe(
      'complete first release',
    );
    await publishEmployeeWebArtifact(
      destination,
      build('complete second release'),
    );
    expect(await readFile(join(destination, 'artifact.json'), 'utf8')).toBe(
      'complete second release',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
