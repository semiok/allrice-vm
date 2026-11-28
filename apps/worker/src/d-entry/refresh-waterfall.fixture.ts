import type { CDPSession, Locator, Page } from 'playwright-core';

function scrub(url: string) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  return parsed.pathname.replace(
    /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi,
    ':id',
  );
}

export async function recordRefreshWaterfall(
  page: Page,
  editor: Locator,
  cdp: CDPSession,
  sample: number,
  cache: 'cold' | 'warm',
) {
  const requests = new Map<
    string,
    {
      path: string;
      type?: string;
      endpoint?: string;
      start: number;
      headersAt?: number;
      end?: number;
      status?: number;
      wireStatus?: number;
      bytes?: number;
      cache?: boolean;
      policy?: string;
      encoding?: string;
    }
  >();
  const frames: { stage: string; time: number }[] = [];
  const streams = new Map<string, string>();
  const recorded = new Set<string>();
  let start: number | undefined;
  const time = (now: number) => Math.round((now - (start ?? now)) * 1000);
  function stage(name: string, timestamp: number) {
    if (start === undefined || recorded.has(name)) return;
    recorded.add(name);
    frames.push({ stage: name, time: time(timestamp) });
  }
  const takeHeaders = (
    headers: Record<string, unknown>,
    name: string,
  ): string | undefined => {
    const key = Object.keys(headers).find((key) => key.toLowerCase() === name);
    const value = key && headers[key];
    return typeof value === 'string' ? value : undefined;
  };
  cdp.on('Network.requestWillBeSent', (event) => {
    if (start === undefined && event.type !== 'Document') return;
    start ??= event.timestamp;
    const path = scrub(event.request.url);
    if (!path) return;
    let endpoint: string | undefined;
    if (path.endsWith('/native-rpc') && event.request.postData) {
      const body = JSON.parse(event.request.postData);
      if (typeof body.endpoint === 'string') endpoint = body.endpoint;
    }
    requests.set(event.requestId, {
      path,
      type: event.type,
      endpoint,
      start: time(event.timestamp),
    });
  });
  cdp.on('Network.requestServedFromCache', ({ requestId }) => {
    const req = requests.get(requestId);
    if (req) req.cache = true;
  });
  cdp.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode }) => {
    const req = requests.get(requestId);
    if (req) req.wireStatus = statusCode;
  });
  cdp.on('Network.responseReceived', (event) => {
    const req = requests.get(event.requestId);
    if (req)
      Object.assign(req, {
        headersAt: time(event.timestamp),
        status: event.response.status,
        cache: req.cache || event.response.fromDiskCache,
        policy: takeHeaders(event.response.headers, 'cache-control'),
        encoding: takeHeaders(event.response.headers, 'content-encoding'),
      });
  });
  cdp.on('Network.loadingFinished', (event) => {
    const req = requests.get(event.requestId);
    if (req)
      Object.assign(req, {
        end: time(event.timestamp),
        bytes: event.encodedDataLength,
      });
  });
  cdp.on('Network.webSocketWillSendHandshakeRequest', ({ timestamp }) =>
    stage('websocket-upgrade', timestamp),
  );
  cdp.on('Network.webSocketHandshakeResponseReceived', ({ timestamp }) =>
    stage('websocket-101', timestamp),
  );
  cdp.on('Network.webSocketFrameSent', (event) => {
    if (event.response.opcode !== 1) return;
    const message = JSON.parse(event.response.payloadData);
    if (message.type !== 'open') return;
    streams.set(message.streamId, message.endpoint);
    stage('open:' + message.endpoint, event.timestamp);
  });
  cdp.on('Network.webSocketFrameReceived', (event) => {
    if (event.response.opcode !== 1) return;
    const message = JSON.parse(event.response.payloadData);
    if (message.type !== 'item') return;
    const endpoint = streams.get(message.streamId);
    if (endpoint) stage('reply:' + endpoint, event.timestamp);
  });
  const started = performance.now();
  await page.reload({ waitUntil: 'commit' });
  await editor.fill('隔离刷新测试', { timeout: 30_000 });
  const editable = Math.round(performance.now() - started);
  const documents = await Promise.all(
    page.frames().map((frame) =>
      frame.evaluate(() => {
        const item = performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined;
        return {
          pathname: location.pathname,
          responseStart: Math.round(item?.responseStart ?? 0),
          responseEnd: Math.round(item?.responseEnd ?? 0),
          domContentLoaded: Math.round(item?.domContentLoadedEventEnd ?? 0),
        };
      }),
    ),
  );
  await cdp.detach();
  console.info(
    'HOT_REFRESH_V2 ' +
      JSON.stringify({
        sample,
        cache,
        editable,
        documents,
        requests: [...requests.values()],
        frames,
      }),
  );
}
