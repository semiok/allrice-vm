import { createHash } from 'node:crypto';
import type { Browser } from 'playwright-core';
import { compareSidebarPixels } from './sidebar-pixels';

export type PanelPixelScope = {
  mode:
    | 'rev2-panel'
    | 'placement-attachment'
    | 'placement-restoration'
    | 'placement-control';
  viewport: { width: number; height: number } | null;
  theme: 'light' | 'dark';
  state: string;
  panel: string;
  expectedCapture: string;
  actualCapture: string;
  unreadDeliverables?: number;
};

type PixelBrowser = { userAgent: string; version: string };
type PngPair = readonly [
  changedPixels: number,
  expectedSha256: string,
  actualSha256: string,
];

export async function readPanelPixelBrowser(
  browser: Browser,
): Promise<PixelBrowser> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { userAgent } = await session.send('Browser.getVersion');
    return { userAgent, version: browser.version() };
  } finally {
    await session.detach();
  }
}

// User-reviewed Linux originals from first attempts 45433602972 and 45468357167.
// Each entry names a fixed scene and orders the original reference before native.
const panels: Readonly<Record<string, PngPair>> = {
  '390-light-list-files': [
    28,
    'b2f2b8d40d827ee83190f5c454d1c6dcffa44d929385cd7496c343123b7de03b',
    'ef954ad2f42d71a9beebdba3ae63bf85267fde89f05d89e34ec6ee96b0b16591',
  ],
  '390-light-empty-files': [
    18,
    '7512c681f8607333c213b149f63fd70e8b7c67cd16cc82bdc8dec2cfac58422a',
    'a531d638a204043dfac694e04e4428e74d38450116af3f87a82be3d57040c918',
  ],
  '390-light-loading-files': [
    18,
    '6470254ea2dcac36bd21e42733862e54e800f1e4c74bdfe15f73ea4cb0ea3a7e',
    'f18742b4c5d80a555a33ff84f803f70e34a312fb9135b83ef1f8805a20e71f3a',
  ],
  '390-light-denied-files': [
    17,
    'c23a26ff02baed2287094ae6706b032dcc4d8c5487800b9582f00e6ef3adafe8',
    'dbc00280652339665616c38021019617cc926f420ed425ce5daa110b5d08a06b',
  ],
  '390-light-denied-materials': [
    13,
    '682ada1923e0e0ff08224d0d5d6fa02728b8906d8c743a40b73c45bea48248d3',
    '4198fbebc6b1e34bf866d4930b58f6d039f348abbf1778d5ec725ca3471748e1',
  ],
  '390-light-longname-files': [
    28,
    '0b8278287e195780043d4bb82f05041c6ac930c2adc008b84fb21976c0251ee8',
    '22a7261626bd215fe2fc46c2b8b849bc25ece6728cf3729c02acc63b37e38f23',
  ],
  '390-dark-list-files': [
    32,
    '66894f16a26e50c41a4b2d2cd8358e838f24ad4c87764e0de699d18c5ed2e927',
    '2024d6fae35d8b511b04af243c75d8c68352e5816175ec7cfce67f29b9891d60',
  ],
  '390-dark-empty-files': [
    19,
    'dea6fbfd505382cf44637c0d97809e13fdc59037fae181cbd72c49f8a1552e41',
    'a9a45627c087a459dc9b6a199a9a00d4c20b38ee7fc93bfb82b636e394ec8424',
  ],
  '390-dark-loading-files': [
    19,
    'f11f891623c0d387894231a0cf7f7fe9df3abb761de88e81404e74f59d298496',
    '3a97f95612af8000475a5953ba5973a59eba124c0b06cee56d6103f3ba2bb2ff',
  ],
  '390-dark-denied-files': [
    18,
    'cd5a45eadf9ebc94750fc3df2ff7754c972970b235ffad9dbad94745d09294a4',
    '022e7a1b63ef8c5ffec7737762b8b5bc014367d67700a6605a4dfc7f8d2a0aa3',
  ],
  '390-dark-denied-materials': [
    13,
    '65b4b64116c180271cb382d11dce98db75f330e3e28cab179e56f7046e723582',
    'f8aca435673ba0a44570366cf3fbf0ec6396dd8e5d797a410d553bdacfa19c2e',
  ],
  '390-dark-longname-files': [
    32,
    '99b5b21b8d72362c0448761cbaaf10325817748565cb6f646db858f669aa2a17',
    '447cb2dc66a3a8bedac29d700f5ff51ac6fbccc632a94c6afa61d0947b6e7f89',
  ],
  '1440-dark-denied-materials': [
    13,
    '67dc0f083626a4e5ad3f613dc74a70d938496c133f4aa8f84c610bd3eae68075',
    '1fb8b5c42feec33cf6006047045b55917d3e2ec642e5f544f4bb3c38bcd373cd',
  ],
};

const placementFrames: PngPair = [
  3,
  'ad9062de437ab9037a7ce4fa719cb71647ad8782d787b4340fc70b87418b313d',
  '6b5237a8f9fbe44376318eb31819e5d113e43c90c05f0bf76d51683232d00535',
];

function reviewedPair(scope: PanelPixelScope) {
  const {
    mode,
    viewport,
    theme,
    state,
    panel,
    expectedCapture,
    actualCapture,
  } = scope;
  if (viewport?.height !== 1000) return null;
  if (
    mode === 'rev2-panel' &&
    expectedCapture === 'rev2-element' &&
    actualCapture === 'native-element'
  ) {
    const id = `${viewport.width}-${theme}-${state}-${panel}`;
    const pair = panels[id];
    if (!pair) return null;
    const mobile = viewport.width === 390;
    return {
      id,
      sourceRunId: mobile ? 45433602972 : 45468357167,
      pair,
      width: mobile ? 389 : 647,
      height: 962,
    };
  }
  if (
    viewport.width !== 1440 ||
    theme !== 'light' ||
    state !== 'list' ||
    panel !== 'experience' ||
    scope.unreadDeliverables !== 5 ||
    expectedCapture !== 'native-original-frame'
  )
    return null;
  const attachment =
    mode === 'placement-attachment' &&
    actualCapture === 'native-attached-frame';
  const restoration =
    mode === 'placement-restoration' &&
    actualCapture === 'native-restored-frame';
  if (!attachment && !restoration) return null;
  return {
    id: attachment ? 'D-attachment' : 'D-restoration',
    sourceRunId: 45468357167,
    pair: placementFrames,
    width: 1440,
    height: 1000,
  };
}

const sha256 = (png: Buffer) => createHash('sha256').update(png).digest('hex');

export function compareApprovedPanelPixels(
  browser: PixelBrowser,
  scope: PanelPixelScope,
  expectedPng: Buffer,
  actualPng: Buffer,
) {
  const pixels = compareSidebarPixels(expectedPng, actualPng);
  const expectedSha256 = sha256(expectedPng);
  const actualSha256 = sha256(actualPng);
  const reviewed = reviewedPair(scope);
  const exception =
    browser.version === '151.0.7922.34' &&
    browser.userAgent.includes('(X11; Linux x86_64)') &&
    reviewed &&
    pixels.dimensionsMatch &&
    pixels.expected.width === reviewed.width &&
    pixels.expected.height === reviewed.height &&
    pixels.changedPixels === reviewed.pair[0] &&
    expectedSha256 === reviewed.pair[1] &&
    actualSha256 === reviewed.pair[2]
      ? { id: reviewed.id, sourceRunId: reviewed.sourceRunId }
      : null;
  return {
    pixels,
    scope,
    browser,
    expectedSha256,
    actualSha256,
    exception,
    accepted:
      pixels.dimensionsMatch &&
      (pixels.changedPixels === 0 || exception !== null),
  };
}
