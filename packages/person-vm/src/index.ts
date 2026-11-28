export * from './contract.ts';
export type {
  PersonVmWebRoster,
  PersonVmWakeStartup,
  PersonVmWebEndpointReceipt,
  PersonVmWebStartup,
  NativeWebSetupFailure,
  PersonVmWebRosterPort,
} from './web-endpoints.ts';
export type {
  PersonVmMemoryGuestPlan,
  PersonVmGuestCommand,
  PersonVmJobExit,
  PersonVmManagedJob,
  PersonVmNativeWebGuestAddress,
  PersonVmStartingScope,
  PersonVmBootstrapScope,
  PersonVmGuestBootstrapPort,
} from './guest-bootstrap.ts';
export * from './admission-contract.ts';
export {
  nativeWebAuthArtifact,
  type PersonVmNativeWebAuth,
  type PersonVmNativeWebAuthRequest,
} from './native-web-auth.ts';
export * from './admission-boundary.ts';
export { PersonVmAdmissionHost } from './admission-host.ts';
export { PersonVmService, sameVmBinding } from './person-vm.ts';
export { PersonVmDiskPool, type PersonVmDiskPoolOptions } from './disk-pool.ts';
export { MacosPersonVmDiskPool } from './disk-pool-macos.ts';
export type {
  PlatformVmDeletionRequest,
  PlatformVmDeletionResult,
} from './platform-deletion.ts';
export {
  PostgresPersonVmStore,
  type PersonVmStore,
  type PersonVmSqlFactory,
  type VmHold,
  type PersonVmLeaseOwner,
  type PersonVmLeaseFencePort,
} from './store.ts';
export {
  MicrosandboxPersonVm,
  type PersonVmNativePort,
} from './microsandbox.ts';
export { isMicrosandboxGuestIpv4 } from './microsandbox-bootstrap.ts';
export {
  ApfsPersonVmDisk,
  FilePersonVmKeyStore,
  type PersonVmDiskPort,
  type PersonVmKeyStore,
  type PersonDisk,
  type PersonVmDiskInspection,
} from './encrypted-disk.ts';

export type {
  PersonVmNativeResourceFacts,
  PersonVmNativeResourcePort,
  PersonVmNativeResourceSubscription,
  PersonVmResourceLiveness,
  PersonVmResourceLifecycleWatch,
  PersonVmResourceLifecyclePort,
  PersonVmResourceWatch,
  PersonVmResourcePort,
} from './resource-contract.ts';
export { createPersonVmResourcePort } from './resource-watch.ts';

export {
  createPersonVmCommandMemoryObserver,
  PERSON_VM_COMMAND_MEMORY_PROGRAM,
  PERSON_VM_COMMAND_MEMORY_VERIFIER,
} from './native-command-observer.ts';
export type {
  PersonVmManagedProbeJob,
  PersonVmManagedProbePort,
  PersonVmNativeCommandExecution,
  PersonVmCommandMemoryCompletion,
} from './native-command-observer.ts';
export {
  COMMAND_MEMORY_CONTROL_FILES,
  COMMAND_MEMORY_STATE_ROOT,
  checkedReadonlyCommandMemoryDirectory,
  hashCommandMemoryControlFiles,
  verifyReadonlyCommandMemoryDirectory,
  type ReadonlyCommandMemoryDirectory,
} from './readonly-artifact.ts';

export {
  createPersonVmGuestMemoryReader,
  PERSON_VM_GUEST_CONTROL_READER,
} from './native-resource.ts';
export type {
  PersonVmGuestControlValue,
  PersonVmGuestControlTarget,
  PersonVmGuestControlReadback,
  PersonVmGuestMemoryReadback,
} from './native-resource.ts';
