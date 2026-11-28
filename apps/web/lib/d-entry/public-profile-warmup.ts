import {
  downloadProfileResource,
  profileDownloadLimits,
  sealedProfileBundleFetch,
} from './profile-download';

export const publicProfileStartupPath =
  /^\/_next\/static\/dsh-profile\/[a-f0-9]{64}\/(?:bundles\/[a-f0-9]{64}\.js|managed\/(?:employee-web-entry\.(?:css|js)|[\w-]+\.js)|native\/assets\/(?:index|vendor)-[\w-]+\.css)(?![\s\S])/;

/** Only the managed static import graph is eligible for modulepreload. The
 * native startup batches are data fetches owned by the document lifecycle. */
export function publicProfileModules(urls: readonly string[]) {
  return [
    ...new Set(
      urls.filter(
        (url) =>
          publicProfileStartupPath.test(url) &&
          /\/managed\/[\w-]+\.js$/.test(url),
      ),
    ),
  ];
}

/** Populate the ordinary HTTP cache, without evaluating code or keeping bytes. */
export async function warmPublicProfileAssets(
  urls: readonly string[],
  signal: AbortSignal,
) {
  const unique = [
    ...new Set(urls.filter((url) => publicProfileStartupPath.test(url))),
  ];
  let next = 0;
  async function drain() {
    while (!signal.aborted && next < unique.length) {
      await downloadProfileResource(
        unique[next++]!,
        signal,
        {
          ...sealedProfileBundleFetch,
          priority: 'low',
          referrerPolicy: 'no-referrer',
        },
        profileDownloadLimits,
        (body) => body.pipeTo(new WritableStream()),
      ).catch(() => {
        // A miss remains the authorized document's responsibility.
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, unique.length) }, drain));
}
