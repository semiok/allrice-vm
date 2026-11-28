'use client';

import { useState } from 'react';
import type {
  EmployeeDetailsProfile,
  EmployeeInstance,
} from '@allrice/contracts';
import type { Session, Workspace } from '../chatflow-types';
import {
  EmployeeArchiveConfirmation,
  EmployeeArchiveDialog,
} from '../employee-archive';
import { EmployeeDetailsDialog } from '../employee-details-dialog';
import { useEmployeeArchive } from '../use-employee-archive';
import { useSessionArchive } from '../use-session-archive';

const noop = () => {};

export interface EmployeeSidebarManagement {
  scopeId: string;
  headers: Record<string, string>;
  lifetime?: AbortSignal;
  onEmployeeChanged(instance: EmployeeInstance): void;
  onSessionChanged(session: Session): void;
}

export function OpenEmployeeArchive({
  workspace,
  management,
  onClose,
}: {
  workspace: Workspace;
  management: EmployeeSidebarManagement;
  onClose(): void;
}) {
  const archive = useEmployeeArchive({
    workspace,
    headers: management.headers,
    onChanged: management.onEmployeeChanged,
  });
  return (
    <EmployeeArchiveDialog
      archive={archive}
      workspace={workspace}
      headers={management.headers}
      entry="4.0"
      lifetime={management.lifetime}
      activeId={null}
      onSessionUpdated={management.onSessionChanged}
      onSessionActivities={noop}
      onSelectSession={noop}
      onPrepareSession={noop}
      onClose={onClose}
    />
  );
}

export function useEmployeeSidebarManagement(
  workspace: Workspace | null,
  management?: EmployeeSidebarManagement,
) {
  const [showArchive, setShowArchive] = useState(false);
  const [details, setDetails] = useState<string>();
  const [confirmation, setConfirmation] = useState<EmployeeDetailsProfile>();
  const headers = management?.headers ?? noHeaders;
  const archive = useSessionArchive({
    workspace: management ? workspace : null,
    headers,
    entry: '4.0',
    lifetime: management?.lifetime,
    onUpdated: management?.onSessionChanged ?? noop,
    onActivities: noop,
    onShowArchived: () => setShowArchive(true),
  });
  const employeeArchive = useEmployeeArchive({
    workspace: confirmation ? workspace : null,
    headers,
    onChanged: management?.onEmployeeChanged ?? noop,
  });
  if (!workspace || !management) return;
  return {
    archive,
    showArchive,
    openArchive: () => setShowArchive(true),
    openDetails: setDetails,
    overlays: (
      <>
        {archive.overlays}
        {showArchive && (
          <OpenEmployeeArchive
            workspace={workspace}
            management={management}
            onClose={() => setShowArchive(false)}
          />
        )}
        {details && !confirmation && (
          <EmployeeDetailsDialog
            open
            personaOnly
            scopeId={management.scopeId}
            workspaceId={workspace.workspaceId}
            instanceId={details}
            headers={headers}
            onProfileUpdated={management.onEmployeeChanged}
            onArchive={setConfirmation}
            onClose={() => setDetails(undefined)}
          />
        )}
        {confirmation && (
          <EmployeeArchiveConfirmation
            archive={employeeArchive}
            target={confirmation}
            onCancel={() => setConfirmation(undefined)}
            onArchived={() => {
              setConfirmation(undefined);
              setDetails(undefined);
            }}
          />
        )}
      </>
    ),
  };
}

const noHeaders = {};
