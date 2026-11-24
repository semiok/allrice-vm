import type { MemorySourceViewProjection } from '@allrice/contracts';

const typeLabels: Record<MemorySourceViewProjection['sourceType'], string> = {
  user: '手动添加',
  message: '来自对话',
  checkpoint: '来自会话快照',
  file: '来自文件',
  tool: '来自工具',
  connector: '来自已连接的服务',
};

const labelTranslations = new Map<
  string,
  { label: string; sourceType?: MemorySourceViewProjection['sourceType'] }
>([
  ['模型提取候选', { label: '对话中自动记下', sourceType: 'message' }],
  ['用户保存的记忆', { label: '手动添加' }],
  ['用户更正', { label: '手动修改过' }],
  ['legacy memory', { label: '历史记忆' }],
]);
const storedConfirmationSuffix = ' · 用户确认';

/** Formats stored memory source labels for the approved MET-284 display. */
export function memorySourceCopy({
  sourceType,
  sourceLabel,
}: MemorySourceViewProjection) {
  // r1-exempt(display): The stored suffix only changes the rendered description. Other labels still render.
  const hasSuffix = sourceLabel.endsWith(storedConfirmationSuffix);
  const original = hasSuffix
    ? sourceLabel.slice(0, -storedConfirmationSuffix.length)
    : sourceLabel;
  // r1-exempt(display): Translates listed labels for display and renders unlisted labels as stored, with a placeholder for empty text.
  const translation = labelTranslations.get(original);
  let label = original.trim() ? original : '来源说明未记录';
  if (
    translation &&
    (translation.sourceType === undefined ||
      translation.sourceType === sourceType)
  ) {
    label = translation.label;
  }
  return {
    type: typeLabels[sourceType],
    label: hasSuffix ? `${label} · 已确认` : label,
  };
}
