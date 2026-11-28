'use client';

import { useMemo, useState } from 'react';
import {
  IconArchiveOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { Workspace } from '../chatflow-types';
import { OpenEmployeeArchive } from './employee-sidebar-management';
import archiveStyles from '../session-archive.module.css';
import { EmployeeCreateDialog } from '../employee-create-dialog';
import styles from './employee-native-page.module.css';

export function EmployeeFirstStart({
  organizationId,
  workspaceId,
  viewerId,
}: {
  organizationId: string;
  workspaceId: string;
  viewerId: string;
}) {
  const [open, setOpen] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const workspace = useMemo<Workspace>(
    () => ({
      organizationId,
      workspaceId,
      viewerId,
      canAdminister: false,
      employees: [],
      employeeProfiles: [],
      sessions: [],
      sessionModels: [],
    }),
    [organizationId, workspaceId, viewerId],
  );
  const headers = useMemo(
    () => ({
      'x-allrice-organization-id': organizationId,
      'x-allrice-workspace-id': workspaceId,
      'x-allrice-expected-viewer-id': viewerId,
    }),
    [organizationId, workspaceId, viewerId],
  );

  return (
    <main className={styles.status}>
      <section>
        <h1>新建你的第一个员工</h1>
        <p>给员工起个名字，建好后就能打开工作台。</p>
        <div className={archiveStyles.newWorkActions}>
          <button type="button" onClick={() => setOpen(true)}>
            创建员工
          </button>
          <Tooltip label="查看归档">
            <button
              type="button"
              aria-label="查看归档"
              onClick={() => setShowArchive(true)}
            >
              <IconArchiveOutlineRegular size={18} />
            </button>
          </Tooltip>
        </div>
      </section>
      {open && (
        <EmployeeCreateDialog
          personal
          workspace={{ organizationId, workspaceId, viewerId }}
          headers={headers}
          onClose={() => setOpen(false)}
          onCreated={(instance) => {
            const query = new URLSearchParams({
              workspaceId: instance.workspaceId,
              employeeInstanceId: instance.id,
            });
            window.location.assign(`/chatflow/4.0?${query}`);
          }}
        />
      )}
      {showArchive && (
        <OpenEmployeeArchive
          workspace={workspace}
          management={{
            scopeId: viewerId,
            headers,
            onEmployeeChanged: (instance) => {
              if (!instance.archivedAt) window.location.assign('/chatflow/4.0');
            },
            onSessionChanged: () => {},
          }}
          onClose={() => setShowArchive(false)}
        />
      )}
    </main>
  );
}
