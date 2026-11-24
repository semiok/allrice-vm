import { platformRepository } from '../../../packages/database/src/platform-repository-credential-contracts.ts';

const devReadiness = {
  web: 'http://127.0.0.1:3311/api/health/ready',
  worker: 'http://127.0.0.1:3312/health/ready',
};

// Baseline registration reads the same verified identity as deploy-dev.
export async function readDevReleaseSha(
  read: typeof fetch = fetch,
): Promise<string> {
  const [web, worker] = await Promise.all(
    Object.entries(devReadiness).map(async ([service, url]) => {
      try {
        const reply = await read(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!reply.ok) throw Error('not ready');
        const { status, identity } = await reply.json();
        if (
          status !== 'ready' ||
          identity?.environment !== 'dev' ||
          identity?.service !== service ||
          identity?.repository !== platformRepository.fullName ||
          identity?.mode !== 'production' ||
          !/^[a-f0-9]{40}$/.test(identity.sourceSha) ||
          !/^[a-f0-9]{40}$/.test(identity.sourceTree) ||
          !/^sha256:[a-f0-9]{64}$/.test(identity.manifestDigest)
        )
          throw Error('missing verified identity');
        return identity;
      } catch (error) {
        throw Error(`REPOSITORY_DEV_IDENTITY_UNAVAILABLE: ${service}`, {
          cause: error,
        });
      }
    }),
  );
  if (
    web.sourceSha !== worker.sourceSha ||
    web.sourceTree !== worker.sourceTree ||
    web.manifestDigest !== worker.manifestDigest
  )
    throw Error('REPOSITORY_DEV_IDENTITY_MISMATCH');
  return web.sourceSha;
}
