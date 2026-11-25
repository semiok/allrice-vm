import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

export function createDEntryNativeGateway(options: {
  port: number;
  probe?: (url: string, init: RequestInit) => Promise<Response>;
  connect?: (
    url: URL,
    options: { headers: { authorization: string }; followRedirects: false },
  ) => WebSocket;
}): {
  matches(request: IncomingMessage): boolean;
  upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void>;
  close(): Promise<void>;
};
