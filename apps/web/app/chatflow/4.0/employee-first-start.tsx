'use client';

import { useState } from 'react';
import { dEntryFirstEmployeeLimitMessage } from '../../../lib/d-entry/employee-creation';
import { EmployeeCreateDialog } from '../employee-create-dialog';
import styles from './employee-native-page.module.css';

export function EmployeeFirstStart({
  organizationId,
  workspaceId,
  viewerId,
  creationBlocked,
}: {
  organizationId: string;
  workspaceId: string;
  viewerId: string;
  creationBlocked?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (creationBlocked)
    return (
      <main className={styles.status}>
        <section>
          <p role="status">{dEntryFirstEmployeeLimitMessage}</p>
        </section>
      </main>
    );

  return (
    <main className={styles.status}>
      <section>
        <h1>新建你的第一个员工</h1>
        <p>给员工起个名字，建好后就能打开工作台。</p>
        <button type="button" onClick={() => setOpen(true)}>
          创建员工
        </button>
      </section>
      {open && (
        <EmployeeCreateDialog
          personal
          workspace={{ organizationId, workspaceId, viewerId }}
          headers={{
            'x-allrice-organization-id': organizationId,
            'x-allrice-workspace-id': workspaceId,
          }}
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
    </main>
  );
}
