import {
  downloadProfileResource,
  profileDownloadLimits,
  sealedProfileBundleFetch,
} from './profile-download';

export const publicProfileStartupPath =
  /^\/_next\/static\/dsh-profile\/[a-f0-9]{64}\/(?:bundles\/[a-f0-9]{64}\.js|managed\/(?:employee-web-entry\.(?:css|js)|[\w-]+\.js)|native\/assets\/(?:index|vendor)-[\w-]+\.(?:js|css))(?![\s\S])/;

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
