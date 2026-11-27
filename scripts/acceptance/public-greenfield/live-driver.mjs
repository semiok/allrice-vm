import { paths, requireFact } from './contracts.mjs';

const replyJson = new Set([
  paths.login,
  paths.employee,
  paths.prewarm,
  paths.poll,
  paths.thread,
  paths.identity,
]);
const streams = new Set(['$events', 'remoteAccess/follow', 'session/follow']);

/** Forward real browser traffic, inspecting only the contract facts we need. */
export function publicDriver() {
  return {
    chromiumArgs: ['--no-proxy-server'],
    async install(
      context,
      { inspect, muxRole, beginCarrier, observeFollow, followClosed, fail },
    ) {
      await context.route('**/*', async (route) => {
        let response;
        try {
          const request = route.request();
          const method = request.method();
          const url = new URL(request.url());
          const body = method === 'POST' ? request.postDataJSON() : undefined;
          await inspect(
            {
              url,
              method,
              body,
              organization: await request.headerValue(
                'x-allrice-organization-id',
              ),
              workspace: await request.headerValue('x-allrice-workspace-id'),
            },
            async () => {
              response = await route.fetch({
                maxRedirects: 0,
                maxRetries: 0,
                timeout: 60_000,
              });
              const status = response.status();
              const parse =
                replyJson.has(url.pathname) ||
                (url.pathname === paths.rpc &&
                  body?.endpoint === 'session/prompt');
              return {
                status,
                json:
                  parse &&
                  (response.headers()['content-type'] ?? '').startsWith(
                    'application/json',
                  )
                    ? await response.json()
                    : undefined,
              };
            },
          );
          await route.fulfill({ response });
        } catch (error) {
          fail(error);
          await route.abort('blockedbyclient').catch(() => {});
        } finally {
          await response?.dispose().catch(() => {});
        }
      });

      const connected = new Set();
      await context.routeWebSocket('**/*', (socket) => {
        let server;
        const stop = (error) => {
          fail(error);
          void socket.close().catch(() => {});
          void server?.close().catch(() => {});
        };
        try {
          const url = new URL(socket.url());
          const role = muxRole(url);
          requireFact(
            !connected.has(role),
            'native-websocket-reconnect-blocked',
          );
          connected.add(role);
          server = socket.connectToServer();
          let ownerStream;
          let verifyOpen;
          let closeRequested = false;
          const openStreams = new Map();
          socket.onMessage((message) => {
            try {
              requireFact(
                typeof message === 'string',
                'native-websocket-frame-blocked',
              );
              const frame = JSON.parse(message);
              requireFact(
                typeof frame?.streamId === 'string' &&
                  frame.streamId.length > 0,
                'native-websocket-stream-unverified',
              );
              if (role === 'owner') {
                if (!ownerStream) {
                  verifyOpen = beginCarrier(url, frame);
                  ownerStream = frame.streamId;
                } else {
                  requireFact(
                    frame.streamId === ownerStream &&
                      ((frame.type === 'item' &&
                        frame.value === 'close' &&
                        !closeRequested) ||
                        frame.type === 'cancel' ||
                        (frame.type === 'end' && closeRequested)),
                    'native-websocket-frame-blocked',
                  );
                  if (frame.type === 'item') closeRequested = true;
                }
              } else if (frame.type === 'open') {
                requireFact(
                  streams.has(frame.endpoint) &&
                    !openStreams.has(frame.streamId),
                  'native-websocket-open-blocked',
                );
                const address = frame.payload?.args?.request?.address;
                openStreams.set(
                  frame.streamId,
                  frame.endpoint === 'session/follow' &&
                    address?.kind === 'session'
                    ? address.sessionId
                    : null,
                );
              } else {
                requireFact(
                  frame.type === 'cancel' || frame.type === 'end',
                  'native-websocket-frame-blocked',
                );
                openStreams.delete(frame.streamId);
              }
              server.send(message);
            } catch (error) {
              stop(error);
            }
          });
          server.onMessage((message) => {
            try {
              requireFact(
                typeof message === 'string',
                'native-websocket-frame-blocked',
              );
              const frame = JSON.parse(message);
              if (role === 'owner' && verifyOpen) {
                verifyOpen(frame);
                verifyOpen = undefined;
              } else if (role === 'streams') {
                const sessionId = openStreams.get(frame?.streamId);
                if (frame?.type === 'item' && sessionId)
                  observeFollow(sessionId, frame.value);
                if (frame?.type === 'end' || frame?.type === 'error') {
                  if (sessionId) followClosed?.(sessionId);
                  openStreams.delete(frame.streamId);
                }
              }
              socket.send(message);
            } catch (error) {
              stop(error);
            }
          });
        } catch (error) {
          stop(error);
        }
      });
    },
  };
}
