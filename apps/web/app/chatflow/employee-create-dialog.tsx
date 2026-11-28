'use client';
import { useEffect, useRef, useState } from 'react';
import {
  EmployeeInstanceSchema,
  type EmployeeInstance,
} from '@allrice/contracts';
import type { Workspace } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import createCss from './employee-create.module.css';
import {
  EmployeeProfileForm,
  defaultEmployeeProfileFormValues,
  createEmployeeProfile,
  type EmployeeProfileFormValues,
} from './employee-profile-form';
import { readJson } from './chatflow-utils';
import { requestFailureMessage } from '../../lib/chatflow/request-failure';

async function personalEmployeeCapacityMessage(response: Response) {
  if (response.status !== 409) return;
  const body: { error?: { code?: unknown; message?: unknown } } | null =
    await response
      .clone()
      .json()
      .catch(() => null);
  if (body?.error?.code !== 'QUOTA_EXCEEDED') return;
  const message = body.error.message;
  // r1-exempt(own-text): 只显示系统容量门卫随 409 QUOTA_EXCEEDED 返回的名额数。
  const limit =
    typeof message === 'string'
      ? /^每人最多 ([1-9][0-9]*) 个员工$/.exec(message)?.[1]
      : undefined;
  if (limit)
    return `员工名额已满，最多可以有 ${limit} 个员工。可以关闭此窗口，继续使用已有员工。`;
  // r1-exempt(own-text): 只显示系统容量门卫随 409 QUOTA_EXCEEDED 返回的固定停机提示。
  if (message === '当前工作台还没确认停机，停机后可以创建更多员工。')
    return message;
  return '暂时无法创建更多员工。可以关闭此窗口，继续使用已有员工。';
}

type EmployeeCreateDialogProps = {
  onClose: () => void;
  onCreated: (instance: EmployeeInstance) => void;
  headers: Record<string, string>;
} & (
  | { workspace: Workspace; personal?: false }
  | {
      workspace: {
        workspaceId: string;
        organizationId: string;
        viewerId: string;
      };
      personal: true;
    }
);

export function EmployeeCreateDialog({
  workspace,
  onClose,
  onCreated,
  headers,
  personal,
}: EmployeeCreateDialogProps) {
  const assignmentId = personal
    ? undefined
    : (
        workspace.employees.find((employee) => employee.isDefault) ??
        workspace.employees[0]
      )?.id;
  const canCreate = personal === true || Boolean(assignmentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ payload: string; id: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function createEmployee(values: EmployeeProfileFormValues) {
    if (active.current || !canCreate || !values.name.trim()) return;
    const input = {
      workspaceId: workspace.workspaceId,
      ...(personal
        ? { expectedOwnerId: workspace.viewerId }
        : { assignmentId }),
      profile: createEmployeeProfile(values),
    };
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload)
      request.current = { payload, id: crypto.randomUUID() };
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/employee-instances', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...input,
          requestId: request.current.id,
        }),
      });
      if (personal) {
        if (response.status === 401 && window !== window.parent) {
          // A login document inside the native frame cannot acknowledge its close.
          if (!controller.signal.aborted)
            setError(requestFailureMessage({ status: 401 }));
          return;
        }
        const capacity = await personalEmployeeCapacityMessage(response);
        if (capacity) {
          if (!controller.signal.aborted) setError(capacity);
          return;
        }
      }
      const result = await readJson<{ instance: EmployeeInstance }>(response);
      if (controller.signal.aborted) return;
      const instance = EmployeeInstanceSchema.parse(result.instance);
      if (
        personal &&
        (instance.organizationId !== workspace.organizationId ||
          instance.workspaceId !== workspace.workspaceId ||
          instance.ownerId !== workspace.viewerId ||
          instance.kind !== 'custom')
      )
        throw new Error('创建未完成，请重试。');
      onCreated(instance);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '创建未完成，请重试。',
        );
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <DshDialog
      ariaLabel="创建 AI 员工"
      title={
        <>
          创建 AI 员工{' '}
          <span className={createCss.titleDescription}>
            员工由人设、技能、工作场景、插件、记忆五部分组成
          </span>
        </>
      }
      className={createCss.dialog}
      bodyClassName={createCss.body}
      closeDisabled={busy}
      closeIcon={
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      }
      onClose={() => {
        if (!active.current) onClose();
      }}
      initialFocusSelector="[data-employee-name]"
    >
      <EmployeeProfileForm
        mode="create"
        initialValue={defaultEmployeeProfileFormValues}
        busy={busy}
        disabled={!canCreate}
        namePlaceholder={personal ? '例如：文案专家、财务专员' : undefined}
        error={error}
        onSubmit={createEmployee}
        onCancel={onClose}
      />
    </DshDialog>
  );
}
