import { createPortal } from 'react-dom';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NativeSubagentSummary } from '@allrice/contracts';
import { AssistantMarkdown } from '../app/chatflow/assistant-markdown';
import type { ChatPresentationPolicy } from '../app/chatflow/dsh-upstream/presentation/presentation-policy';
import { NativeSubagentProcess } from '../app/chatflow/native-subagent-process';
import { useNativeSubagentFollow } from '../app/chatflow/use-native-subagent-follow';
import type { useNativeSubagents } from '../app/chatflow/use-native-subagents';
import css from './native-subagent-detail.fixture.module.css';

type Child = Extract<
  NativeSubagentSummary['descendants'][number],
  { kind: 'child' }
>;
const activity = (child: Child) =>
  child.running === true
    ? '运行中'
    : child.running === null
      ? '当前活动状态未知'
      : child.timing.lastTurnCompleted
        ? '上次回合已完成'
        : '未运行';
function elapsed(child: Child, now = child.timing.active?.through) {
  const { active, settledMs } = child.timing;
  const seconds = Math.floor(
    (settledMs +
      (active ? Math.max(0, (now ?? active.through) - active.since) : 0)) /
      1000,
  );
  return `${seconds} 秒`;
}
function metrics(child: Child) {
  return `${Object.values(child.usage)
    .reduce((a, b) => a + b, 0)
    .toLocaleString()} tokens · ${elapsed(child)}`;
}

export function LegacySubagentDetailFixture({
  workspaceId,
  sessionId,
  headers,
  observation,
  presentation,
  selected,
  onClose: dismissDetail,
}: {
  workspaceId: string;
  sessionId: string;
  headers: Record<string, string>;
  observation: ReturnType<typeof useNativeSubagents>;
  presentation: ChatPresentationPolicy;
  selected: string | null;
  onClose: () => void;
}) {
  const { reads, revision } = observation;
  const read = reads[sessionId];
  const summary = read && read !== 'error' ? read : null;
  const follow = useNativeSubagentFollow(
    workspaceId,
    sessionId,
    headers,
    summary,
    selected,
    String(revision),
  );
  const hot =
    follow.view && typeof follow.view === 'object' ? follow.view : null;
  const snapshot = hot && 'rows' in hot ? hot : null;
  const detailSummary = hot && 'descendants' in hot ? hot : summary;
  const child = detailSummary?.descendants.find(
    (entry) => entry.id === selected && entry.kind === 'child',
  ) as Child | undefined;
  return (
    <>
      {selected &&
        createPortal(
          <aside
            className={css.detail}
            aria-label="子智能体摘要"
            onKeyDown={(event) => {
              if (event.key === 'Escape') dismissDetail();
            }}
          >
            <header>
              <strong>{child?.label ?? selected}</strong>
              <Button size="sm" autoFocus onClick={dismissDetail}>
                关闭摘要
              </Button>
            </header>
            {child && follow.view !== 'error' && (!follow.enabled || hot) ? (
              <>
                <p>
                  {child.observation.source === 'prepared'
                    ? `历史摘要 · ${activity(child)}`
                    : `运行摘要 · ${activity(child)}`}
                </p>
                {child.title && <h2>{child.title}</h2>}
                <h3>自己的任务</h3>
                <p className={css.text}>{child.task ?? '暂无自有任务记录'}</p>
                {child.running !== true && child.timing.lastTurnCompleted && (
                  <p>上次回合已完成。</p>
                )}
                <p>读取时累计：{metrics(child)}</p>
                <small>
                  用量可能包含继承历史，不代表本次运行账单。耗时冻结于读取时。
                </small>
                <h3>{snapshot ? '自己的过程' : '最后回复'}</h3>
                {snapshot ? (
                  <NativeSubagentProcess
                    key={`${snapshot.childId}/${snapshot.hostEpoch}/${snapshot.stream.instanceId}`}
                    snapshot={snapshot}
                    policy={presentation}
                  />
                ) : (
                  <AssistantMarkdown
                    text={child.lastReply ?? '暂无回复'}
                    allowRemoteImages={false}
                  />
                )}
                {!snapshot && child.lastReplyTruncated && (
                  <small>最后回复已截断。</small>
                )}
              </>
            ) : (
              <p role="status">
                {read === 'error' || follow.view === 'error'
                  ? '暂时无法读取摘要，请刷新。'
                  : '当前活动状态未知，请重新读取摘要。'}
              </p>
            )}
          </aside>,
          document.body,
        )}
    </>
  );
}
