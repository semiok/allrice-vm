// Isolated management UI used only by the loopback PostgreSQL/browser fixture.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminShell } from '../components/admin/admin-shell';
import { EmployeeProduction } from '../app/runtime-console/employee-production';
import { TenantResourceEditor } from '../app/runtime-console/tenant-resource-editor';
import { TenantValidation } from '../app/runtime-console/tenant-validation';
import styles from '../app/runtime-console/tenant-administration.module.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view');
const organizationId = params.get('organizationId');
const workspaceId = params.get('workspaceId');
const subjectId = params.get('subjectId');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {view === 'employees' && (
      <AdminShell items={[]}>
        <EmployeeProduction />
      </AdminShell>
    )}
    {(view === 'quotas' || view === 'environments') &&
      organizationId &&
      workspaceId && (
        <div className={styles.panel}>
          <TenantResourceEditor
            mode={view}
            organizationId={organizationId}
            workspaceId={workspaceId}
            onDirty={() => {}}
            onBusy={() => {}}
          />
        </div>
      )}
    {view === 'validation' && organizationId && workspaceId && subjectId && (
      <TenantValidation
        organizationId={organizationId}
        workspaceId={workspaceId}
        subjectId={subjectId}
        onDirty={() => {}}
        onBusy={() => {}}
      />
    )}
  </StrictMode>,
);
