import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import {
  initialDocumentLifecycle,
  publicStartupBundleUrls,
  type EarlyProfileBundles,
} from './initial-document';
import { pageCompletion, pageRevoked } from './page-messages';

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

it('hands off each download once and waits for an in-flight response to settle before publishing the close', async () => {
  let releaseResponse!: (value: Response) => void;
  const content = new Promise<Response>((resolve) => {
    releaseResponse = resolve;
  });
  const fetch = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(
    () => content,
  );
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
    Response,
    DOMException,
    TransformStream,
    clearTimeout,
    setTimeout,
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
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const owner = sandbox.__ALLRICE_EMPLOYEE_DOCUMENT__!;
  const bytes = owner.earlyBundles.take().get(url)!;
  expect(owner.earlyBundles.take().size).toBe(0);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, {
    credentials: 'omit',
    cache: 'force-cache',
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
  releaseResponse(new Response(new Uint8Array(1)));
  await expect(bytes).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: pageCompletion, scopeId: 'fixture-scope', state: 'closed' },
      'https://allrice.test',
    ),
  );
});

it('requires the browser load event to confirm an unclaimed document after revocation', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const origin = 'https://allrice.test';
  const parent = { postMessage: vi.fn() };
  const stop = vi.fn();
  runInNewContext(initialDocumentLifecycle, {
    AbortController,
    document: {
      currentScript: { dataset: { scopeId: 'fixture-scope' } },
      readyState: 'loading',
    },
    parent,
    location: { origin },
    window: {
      stop,
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
      removeEventListener(type: string) {
        listeners.delete(type);
      },
    },
  });
  listeners.get('message')!({
    isTrusted: true,
    origin,
    source: parent,
    data: { type: pageRevoked, scopeId: 'fixture-scope' },
  });
  expect(stop).toHaveBeenCalledOnce();
  listeners.get('load')!({ isTrusted: false });
  const completed = {
    type: pageCompletion,
    scopeId: 'fixture-scope',
    state: 'closed',
  };
  expect(parent.postMessage).not.toHaveBeenCalledWith(completed, origin);
  listeners.get('load')!({ isTrusted: true });
  expect(parent.postMessage).toHaveBeenLastCalledWith(completed, origin);
  expect(listeners.has('load')).toBe(false);
});
