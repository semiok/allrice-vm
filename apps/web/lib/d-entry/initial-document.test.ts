import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import {
  initialDocumentLifecycle,
  publicStartupBundleUrls,
  type EarlyProfileBundles,
} from './initial-document';
import { pageCompletion } from './page-messages';

const root = '/_next/static/dsh-profile/' + '1'.repeat(64) + '/';
const url = root + 'bundles/' + '2'.repeat(64) + '.js';

it('prepares only hinted application and exact bootstrap paths from the sealed graph', () => {
  const release = {
    root,
    bundles: [
      { reference: 'bootstrap', revision: 'b1', sha256: '2'.repeat(64) },
      { reference: 'application', revision: 'a1', sha256: '3'.repeat(64) },
    ],
  };
  const graph = {
    batches: [
      { phase: 'bootstrap', url: 'bootstrap', rev: 'b2' },
      { phase: 'application', url: 'application', rev: 'a1' },
    ],
  };
  expect(publicStartupBundleUrls({ graph, injections: [] }, release)).toEqual(
    [],
  );
  const publication = {
    graph,
    injections: [{ kind: 'script-preload', src: 'application' }],
  };
  expect(publicStartupBundleUrls(publication, release)).toEqual([
    root + 'bundles/' + '3'.repeat(64) + '.js',
  ]);
  expect(
    publicStartupBundleUrls(publication, {
      ...release,
      root: 'https://elsewhere.test/',
    }),
  ).toEqual([]);
});

it('hands off each download once and waits for a cancelled body before publishing the close', async () => {
  let releaseBody!: (value: ArrayBuffer) => void;
  const content = new Promise<ArrayBuffer>((resolve) => {
    releaseBody = resolve;
  });
  const arrayBuffer = vi.fn(() => content);
  const fetch = vi.fn<
    (
      url: string,
      options: RequestInit,
    ) => Promise<Pick<Response, 'ok' | 'arrayBuffer'>>
  >(async () => ({ ok: true, arrayBuffer }));
  const postMessage = vi.fn();
  const sandbox = {
    AbortController,
    AbortSignal,
    document: {
      currentScript: {
        dataset: {
          scopeId: 'fixture-scope',
          publicStartupBundles: JSON.stringify([url, url]),
        },
      },
    },
    fetch,
    location: { origin: 'https://allrice.test' },
    parent: { postMessage },
    window: { addEventListener() {}, removeEventListener() {} },
    __ALLRICE_EMPLOYEE_DOCUMENT__: undefined as
      | undefined
      | {
          earlyBundles: EarlyProfileBundles;
          finish(state: 'closed'): void;
        },
  };
  runInNewContext(initialDocumentLifecycle, sandbox);
  await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());
  const owner = sandbox.__ALLRICE_EMPLOYEE_DOCUMENT__!;
  const bytes = owner.earlyBundles.take().get(url)!;
  expect(owner.earlyBundles.take().size).toBe(0);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, {
    credentials: 'omit',
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
  owner.finish('closed');
  expect(fetch.mock.lastCall?.[1].signal?.aborted).toBe(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: pageCompletion }),
    expect.any(String),
  );
  releaseBody(new ArrayBuffer(1));
  await expect(bytes).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: pageCompletion, scopeId: 'fixture-scope', state: 'closed' },
      'https://allrice.test',
    ),
  );
});
