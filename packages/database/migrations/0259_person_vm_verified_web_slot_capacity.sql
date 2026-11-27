-- Set by authenticated startup after the provider verifies the physical pool.
-- Older VMs have no such proof until they complete a slotted start.
alter table person_virtual_machines
  add column verified_web_slot_capacity integer
  check (verified_web_slot_capacity between 1 and 65535),
  -- Platform retirement changes the fence even when the VM ID is retained.
  add column prewarm_deletion_fence uuid;
