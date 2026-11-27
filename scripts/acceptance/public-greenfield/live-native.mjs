import { performance } from 'node:perf_hooks';
import { isId, requireFact } from './contracts.mjs';

export const nativeReadMethods = new Set([
  'session/attachment',
  'session/page',
  'session/projections',
  'skills/list',
]);

/** Observe one browser-owned DSH prompt and its durable native turn events. */
export function createHelloProbe(receipt) {
  let sessionId;
  let requestId;
  let started;
  let openTurn;
  let expectedTurn;
  let ended = false;
  let resolve;
  const complete = new Promise((done) => {
    resolve = done;
  });
  let resolveTurn;
  const boundTurn = new Promise((done) => {
    resolveTurn = done;
  });
  const outcome = { dispatched: false, accepted: false, replyObserved: false };
  receipt.hello = outcome;
  const duration = () => Math.round(performance.now() - started);
  function finish() {
    if (ended && outcome.accepted) resolve();
  }
  return {
    complete,
    boundTurn,
    elapsed: duration,
    arm(nativeSessionId) {
      requireFact(
        !sessionId &&
          typeof nativeSessionId === 'string' &&
          nativeSessionId.length > 0 &&
          nativeSessionId.length <= 256,
        'hello-native-session-unverified',
      );
      sessionId = nativeSessionId;
      started = performance.now();
    },
    dispatch(body) {
      const request = body?.payload?.args?.request;
      const content = request?.content;
      requireFact(
        sessionId &&
          !requestId &&
          request?.sessionId === sessionId &&
          isId(request.requestId) &&
          typeof body.rpcId === 'string' &&
          body.rpcId.length > 0 &&
          request.mode === 'queue' &&
          Array.isArray(content) &&
          content.length === 1 &&
          content[0]?.type === 'text' &&
          content[0].text === '你好' &&
          Object.keys(content[0]).length === 2,
        'hello-prompt-blocked',
      );
      requestId = request.requestId;
      outcome.dispatched = true;
      outcome.requestFingerprint = createHash('sha256')
        .update(JSON.stringify([sessionId, requestId]))
        .digest('hex');
      return body.rpcId;
    },
    accept(rpcId, { status, json }) {
      requireFact(
        status === 200 &&
          json?.type === 'server-response' &&
          json.rpcId === rpcId &&
          json.result?.ok === true &&
          json.result.value?.accepted === true,
        'hello-admission-unconfirmed',
        status,
      );
      outcome.accepted = true;
      finish();
    },
    closed(target) {
      requireFact(
        target !== sessionId || !requestId || ended,
        'hello-reply-stream-closed',
      );
    },
    follow(target, item) {
      if (!requestId || target !== sessionId || item?.type !== 'event' || ended)
        return;
      const { type, data } = item.event ?? {};
      if (type === 'turn/start') openTurn = data?.turn;
      if (type === 'user/message' && data?.source?.kind === 'user') {
        requireFact(
          data.source.rpcId === requestId &&
            Number.isInteger(openTurn) &&
            expectedTurn === undefined,
          'hello-user-event-mismatch',
        );
        expectedTurn = openTurn;
        outcome.correlation = createHash('sha256')
          .update(JSON.stringify([sessionId, requestId, expectedTurn]))
          .digest('hex');
        resolveTurn(expectedTurn);
      }
      if (expectedTurn === undefined || data?.turn !== expectedTurn) return;
      if (
        type === 'assistant/message' &&
        !data.interrupted &&
        data.message?.content?.some?.(
          (block) =>
            block?.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.trim(),
        )
      ) {
        outcome.replyObserved = true;
      }
      if (type === 'turn/end') {
        requireFact(
          outcome.replyObserved && data.reason?.kind === 'completed',
          'hello-reply-unconfirmed',
        );
        ended = true;
        receipt.timings.helloToNativeTurnEndMs = duration();
        finish();
      }
    },
  };
}
import { createHash } from 'node:crypto';
