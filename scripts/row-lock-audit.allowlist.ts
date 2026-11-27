/**
 * Reviewed exceptions for `row-lock-audit.test.ts` (MET-210 #4). Every entry
 * needs a reason a reviewer can check; the test fails on stale entries.
 */

/** GET handlers that write by design; their locks protect those writes. */
export const writingGetRoutes: readonly { route: string; reason: string }[] = [
  {
    route: 'apps/web/app/api/v1/connections/callback/route.ts',
    reason:
      'OAuth redirect callback: completeOAuthCallback stores the connector authorization (oauth_envelope/oauth_stage) and an audit row in the same transaction.',
  },
];

const BRIDGE_FILE_TRANSFERS =
  'apps/web/app/api/v1/bridge/device/file-transfers/[kind]/[id]/route.ts';
const LEASE_RENEWAL =
  'Rice Bridge device protocol: authorizing or downloading an operation transfer renews the operation lease in its own transaction (ledger heartbeat UPDATE); its locks keep a revoked operation from being renewed. Everything else this GET reads is still audited.';

/**
 * Functions a GET route calls that run a writing transaction or an explicitly
 * approved short final authorization transaction. The audit skips only this call.
 */
export const writingGetCalls: readonly {
  route: string;
  file: string;
  owner: string;
  reason: string;
}[] = [
  {
    route: 'apps/web/app/api/v1/references/publications/route.ts',
    file: 'packages/database/src/reference-search.ts',
    owner: 'assertPreparedReferencesReadable',
    reason:
      'MET-247 approved final current-principal/publication/exact-pin gate (2026-11-14 P1). Only this short authorization transaction holds SHARE locks; full text scan and decoding stay outside and remain audited.',
  },
  {
    route: 'apps/web/app/api/v1/references/revisions/[id]/selection/route.ts',
    file: 'packages/database/src/reference-runtime.ts',
    owner: 'readReferenceInputSelection',
    reason:
      'MET-247 v1.7 approved reference-time permission check: short principal/publication/exact-pin transaction before returning a chip; no text extraction, Run, receipt or remote work.',
  },
  {
    route:
      'apps/web/app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/materials/route.ts',
    file: 'packages/database/src/reference-search.ts',
    owner: 'assertPreparedReferencesReadable',
    reason:
      'The D panel calls the same MET-247 publication search owner and final principal/publication/exact-pin SHARE transaction, after the unlocked text scan. BFF checks and the remainder of the route stay audited.',
  },
  {
    route:
      'apps/web/app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/materials/revisions/[revisionId]/selection/route.ts',
    file: 'packages/database/src/reference-runtime.ts',
    owner: 'readReferenceInputSelection',
    reason:
      'The D panel calls the same MET-247 v1.7 exact revision-to-chip owner with its original short principal/publication/pin check. This does not exempt any other materials or receipt method.',
  },
  {
    route: BRIDGE_FILE_TRANSFERS,
    file: 'packages/database/src/runtime-ledger/ledger.ts',
    owner: 'heartbeat',
    reason: LEASE_RENEWAL,
  },
  {
    route: BRIDGE_FILE_TRANSFERS,
    file: 'packages/database/src/runtime-governed-bridge.ts',
    owner: 'createGovernedBridgeOperationLedger',
    reason: `${LEASE_RENEWAL} The factory only assembles the policy admission and ledger closures the heartbeat transaction runs.`,
  },
];

/** Lock clauses reviewed on a GET path (file, owner function, clause). */
export const reviewedGetLocks: readonly {
  file: string;
  owner: string;
  clause: string;
  reason: string;
}[] = [];

const EMPLOYEE_MEMORY_SOURCE_GET_REVIEW =
  'The personal source GET uses a read-only repeatable-read snapshot. ' +
  'Administrator source skips personal qualification. readAdmin uses plain SELECTs and the existing append-only audit INSERT in a repeatable-read transaction without explicit row or advisory lock clauses. ' +
  'Foreign-key checks on the audit INSERT can take implicit KEY SHARE locks. ' +
  'Existing GET session authentication updates last_seen_at before the business call, outside this explicit-clause gate. ' +
  'Re-review changes to either GET assembly or implementation.';

/** Interface-typed calls on GET paths the audit cannot follow. */
export const reviewedUnresolvedCalls: readonly {
  target: string;
  reason: string;
}[] = [
  {
    target: 'apps/web/lib/d-entry/employee-panels-context.ts authorize',
    reason:
      'The registered production BFF dependency is requireEmployeePanelsAccess. On GET current and currentModule pass only context and selection, using the unlocked instance/thread and rollout read. The transactional branch is called only from the deliverable upload owner, and this entry does not stop traversal of the implementation.',
  },
  {
    target: 'apps/web/lib/d-entry/employee-panels-context.ts context',
    reason:
      'Both production uses call getRequestContext on the original request. It resolves the Cookie session and current tenant with the existing lock-free identity reads.',
  },
  {
    target: 'apps/web/lib/d-entry/employee-panels-context.ts storage',
    reason:
      'The production dependency is getStorageAdapter, which initializes the configured LocalStorageAdapter and returns the same object storage port. No SQL runs here.',
  },
  {
    target: 'apps/web/lib/d-entry/employee-panels-download.ts open',
    reason:
      'The only production PanelResource values passed to preview bytes and spool are the exact materials or deliverable owner resources selected in employee-panels-http. Both open the verified byte stream after lock-free current resource reads, with SQL callbacks still audited.',
  },
  {
    target: 'apps/web/lib/runtime/static-artifact-preview.ts bytes',
    reason:
      'The D panel installs a bounded readPanelResourceBytes callback for its pinned object. It drains the same authorized byte stream and never completes a reservation or writes.',
  },
  {
    target: 'packages/database/src/authorized-file-resource.ts openSource',
    reason:
      'For GET panel reads the two production closures open storage.get on the exact owner-checked object supplied by recheck. This callback itself has no SQL.',
  },
  {
    target: 'packages/database/src/authorized-file-resource.ts recheck',
    reason:
      'The D GET closures are the current deliverable ownedFile and materials authorized revision reads. They verify the fixed resource and requalify the Cookie without a transaction. Their actual SQL call sites, including any future locking changes, stay audited.',
  },
  {
    target: 'apps/web/server/preview-diagnostics.d.mts emit',
    reason:
      'preview-diagnostics.mjs emit hashes the reference id and logs fixed diagnostic fields and bounded error causes; its current implementation runs no SQL.',
  },
  {
    target: 'apps/web/server/preview-diagnostics.d.mts object',
    reason:
      'preview-diagnostics.mjs object only hashes the object id into the diagnostic closure; its current implementation runs no SQL.',
  },
  {
    target: 'apps/web/server/preview-diagnostics.d.mts phase',
    reason:
      'preview-diagnostics.mjs phase records timing and outcome around await body(); the body may run SQL and is not exempt. Current inline callbacks remain traversed in the caller AST; implementation or callback-shape changes require review.',
  },
  {
    target: 'packages/database/src/d-entry-authority.ts changed',
    reason:
      'MET-260 11528559 exact review: module-private Subscription has one current production registration in watchDEntryAuthority. changed applies in-memory affects then enqueue -> recheck; current authority snapshot checks have no row-lock clauses and watch setup also calls enqueue directly. Implementations remain traversed and lock clauses remain audited; callback/producer changes require review and the existing stale-entry check still applies.',
  },
  {
    target: 'packages/database/src/d-entry-authority.ts lost',
    reason:
      'MET-260 11528559 exact review: module-private Subscription has one current production registration in watchDEntryAuthority; lost is invalidate -> abort.abort(error), with no SQL. This unresolved-target review does not stop implementation traversal; callback/producer changes require review and the existing stale-entry check still applies.',
  },
  {
    target: 'packages/database/src/d-entry-authority.ts close',
    reason:
      'The only production history subscription comes from watchDEntryHistoryAuthority. Its close fences abort, detaches and unregisters the exact listener and joins the existing current-read queue. Neither teardown nor those reads hold row locks.',
  },
  {
    target: 'packages/database/src/d-entry-authority.ts verifyBinding',
    reason:
      'The Web history and download GET handlers use watchDEntryHistoryAuthority without NativeRosterChecks, so VM notifications return before invoking verifyBinding. Only the Worker prompt owner supplies this callback through watchDEntryNativeRosterAuthority. Re-review if a GET caller supplies these checks.',
  },
  {
    target: 'packages/database/src/d-entry-authority.ts verifyRoster',
    reason:
      'The Web history and download GET handlers use watchDEntryHistoryAuthority without NativeRosterChecks, so the optional verifyRoster call does not run. The Worker prompt owner supplies the only production implementation. Its roster FOR SHARE is outside this GET review. Re-review if a GET caller supplies these checks.',
  },
  {
    target: 'packages/contracts/src/storage.ts get',
    reason: 'Object storage adapters read blobs; they run no SQL.',
  },
  {
    target: 'packages/database/src/builtin-modules.ts require',
    reason: `The D panel module callback and personal Web memory-source GET both use createApplicationBuiltinModuleAuthority('web'). The require implementation reads the verified build identity from the filesystem or process cache and checks the frozen built-in policy without SQL. ${EMPLOYEE_MEMORY_SOURCE_GET_REVIEW}`,
  },
  {
    target:
      'packages/database/src/employee-memory-port.ts requireCurrentAccess',
    reason: `The personal Web callback resolves D-entry history with only the workspace and employee instance IDs. Current instance and assignment checks use plain SELECT with lock=false. The callback then checks the built-in module policy. ${EMPLOYEE_MEMORY_SOURCE_GET_REVIEW}`,
  },
  {
    target: 'packages/database/src/employee-memory-port.ts source',
    reason: `The port selects getPersonalEmployeeMemorySource or getAdminEmployeeMemorySource based on the parsed organizationId. The personal branch checks current access before and after the owner read, whose scope uses the default write=false. ${EMPLOYEE_MEMORY_SOURCE_GET_REVIEW}`,
  },
];
