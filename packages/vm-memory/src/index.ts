export {
  VM_MEMORY_CONTRACT_VERSION,
  VM_MEMORY_POLICY,
  VmMemoryError,
} from './contract.ts';
export type {
  GuestMemorySample,
  VmMemoryObservation,
  VmMemorySourceWatch,
  VmMemorySource,
  VmMemoryAdmissionWatch,
  VmMemoryAdmissionPort,
  VmMemoryErrorCode,
} from './contract.ts';
export { createVmMemoryAdmission } from './admission.ts';
export { createVmMemoryGuestPlan } from './guest-config.ts';
export type { VmMemoryGuestPlan } from './guest-config.ts';
