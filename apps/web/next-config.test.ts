import { dirname, join } from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { REFERENCE_UPLOAD_MAX_BYTES } from '@allrice/contracts';
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants.js';
import { getCloneableBody } from 'next/dist/server/body-streams.js';
import ts from 'typescript';
import { expect, it } from 'vitest';
import configureNext from './next.config.js';

const directory = dirname(fileURLToPath(import.meta.url));
function readConfig(name: string) {
  const loaded = ts.readConfigFile(join(directory, name), ts.sys.readFile);
  expect(loaded.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    directory,
  );
  expect(parsed.errors).toEqual([]);
  return parsed;
}

it('keeps full test type coverage while production retains every non-test root and compiler option', () => {
  const full = readConfig('tsconfig.json');
  const production = readConfig('tsconfig.next-build.json');
  const suffixes = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
  expect(full.fileNames).toContain(
    join(directory, 'app/chatflow/reference-library.browser.test.ts'),
  );
  expect(new Set(production.fileNames)).toEqual(
    new Set(
      full.fileNames.filter(
        (file) => !suffixes.some((suffix) => file.endsWith(suffix)),
      ),
    ),
  );
  expect(production.fileNames).toContain(
    join(directory, 'app/api/v1/references/route.ts'),
  );
  expect(production.options).toEqual(full.options);
  expect(production.options.strict).toBe(true);
  expect(production.raw.include).toEqual(full.raw.include);
  expect(production.raw.include).toEqual(
    expect.arrayContaining([
      'next-env.d.ts',
      '.next/types/**/*.ts',
      '.next/dev/types/**/*.ts',
    ]),
  );
});

it('selects the production roots only during a production build and preserves all other configuration', () => {
  const development = configureNext(PHASE_DEVELOPMENT_SERVER);
  expect(development.typescript?.tsconfigPath).toBeUndefined();
  expect(configureNext(PHASE_PRODUCTION_SERVER)).toBe(development);
  expect(configureNext(PHASE_PRODUCTION_BUILD)).toEqual({
    ...development,
    typescript: {
      ...development.typescript,
      tsconfigPath: 'tsconfig.next-build.json',
    },
  });
});

it('buffers Base64 JSON for legal publications above the Next default limit', async () => {
  const limit = configureNext(PHASE_PRODUCTION_SERVER).experimental
    ?.proxyClientMaxBodySize;
  expect(typeof limit).toBe('number');
  expect(limit as number).toBeGreaterThan(
    4 * Math.ceil(REFERENCE_UPLOAD_MAX_BYTES / 3) + 16 * 1024,
  );
  const json = Buffer.from(
    JSON.stringify({
      origin: 'upload',
      contentBase64: Buffer.alloc(12 * 1024 * 1024, 97).toString('base64'),
    }),
  );
  const socket = new Socket();
  try {
    const request = new IncomingMessage(socket);
    const body = getCloneableBody(request, limit as number);
    const clone = buffer(body.cloneBodyStream());
    request.push(json.subarray(0, 10 * 1024 * 1024));
    request.push(json.subarray(10 * 1024 * 1024));
    request.push(null);
    expect((await clone).length).toBe(json.length);
    await body.finalize();
    expect((await buffer(request)).equals(json)).toBe(true);
  } finally {
    socket.destroy();
  }
});
