import { expect, it } from 'vitest';
import {
  PersonVmError,
  type PersonVmBinding,
} from '../../../packages/person-vm/src/contract.ts';
import {
  PersonVmService,
  sameVmBinding,
} from '../../../packages/person-vm/src/person-vm.ts';
import {
  bindingOf,
  type PersonVmStore,
} from '../../../packages/person-vm/src/store.ts';
import {
  context,
  harness,
  MemoryStore,
  running,
  signal,
} from '../../../packages/person-vm/src/test-support.ts';

const organization = '00000000-0000-4000-8000-000000000001';
const snow = '00000000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-000000000003';
const acceptance = '00000000-0000-4000-8000-000000000004';

function exactDeletionService(
  mock: ReturnType<typeof harness>,
  approved: PersonVmBinding,
) {
  // The fixture verifies exact identity under the same lease used by delete.
  // The mock authority still decides whether delete and delete-disk are allowed.
  const exact = Object.freeze({ ...approved });
  const store: PersonVmStore = {
    read: mock.store.read.bind(mock.store),
    recover: mock.store.recover.bind(mock.store),
    async withLease(personId, options, work) {
      if (personId !== exact.personId)
        throw new PersonVmError('AUTHORIZATION_DENIED');
      return mock.store.withLease(personId, options, async (lease) => {
        if (!lease.row || !sameVmBinding(bindingOf(lease.row), exact))
          throw new PersonVmError('LEASE_LOST');
        return work(lease);
      });
    },
  };
  return new PersonVmService({ ...mock.options, store });
}

it('deletes only the two approved VM bindings through PersonVmService and retries without deleting disks again', async () => {
  const store = new MemoryStore();
  const mock = harness(store);
  const targets = [
    await running(mock, context(organization, snow)),
    await running(mock, context(organization, acceptance)),
  ];
  const other = await running(mock, context(organization, admin));
  const untouched = await store.read(admin);

  for (const { rc, binding } of targets) {
    const service = exactDeletionService(mock, binding);
    mock.states.set(binding.vmId, 'stopped');
    mock.authorizeDiskDelete(false);
    await expect(
      service.delete(rc, { deleteDisk: true }, signal()),
    ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
    expect(mock.disks.has(binding.vmId)).toBe(true);
    expect(mock.mounts.has(binding.vmId)).toBe(true);

    mock.authorizeDiskDelete(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        service.delete(rc, { deleteDisk: true }, signal()),
      ).resolves.toMatchObject({
        vmId: binding.vmId,
        personId: binding.personId,
        organizationId: binding.organizationId,
        phase: 'deleted',
        diskRetained: false,
      });
      expect(await store.read(binding.personId)).toMatchObject({
        instanceId: binding.instanceId,
        leaseEpoch: binding.leaseEpoch,
        leaseOwner: null,
      });
      expect(mock.disks.has(binding.vmId)).toBe(false);
      expect(mock.mounts.has(binding.vmId)).toBe(false);
      expect(mock.states.get(other.binding.vmId)).toBe('running');
      expect(mock.disks.has(other.binding.vmId)).toBe(true);
      expect(mock.mounts.has(other.binding.vmId)).toBe(true);
      expect(await store.read(admin)).toEqual(untouched);
    }
  }
  expect(mock.log.filter((item) => item === 'disk:delete')).toHaveLength(2);
  expect(
    store.audits.some(
      (event) =>
        event.vmId === other.binding.vmId && event.action.startsWith('delete'),
    ),
  ).toBe(false);
});

it('rejects cross-person or replaced bindings and preserves disks when native state is unknown', async () => {
  const mock = harness();
  const target = await running(mock, context(organization, snow));
  const other = await running(mock, context(organization, acceptance));
  mock.authorizeDiskDelete(true);
  const exact = exactDeletionService(mock, target.binding);
  const before = [...mock.log];
  await expect(
    exact.delete(other.rc, { deleteDisk: true }, signal()),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });

  const wrongBindings: PersonVmBinding[] = [
    { ...target.binding, organizationId: context().organizationId },
    { ...target.binding, vmId: other.binding.vmId },
    { ...target.binding, instanceId: other.binding.instanceId },
    { ...target.binding, leaseEpoch: target.binding.leaseEpoch + 1 },
  ];
  for (const wrong of wrongBindings) {
    await expect(
      exactDeletionService(mock, wrong).delete(
        target.rc,
        { deleteDisk: true },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  }
  expect(mock.log).toEqual(before);

  mock.states.set(target.binding.vmId, 'unknown');
  await expect(
    exact.delete(target.rc, { deleteDisk: true }, signal()),
  ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
  expect(mock.log.slice(before.length)).not.toContain('disk:delete');
  expect(mock.log.slice(before.length)).not.toContain('disk:detach');
  expect(mock.log.slice(before.length)).not.toContain('native:stop');
  for (const { binding } of [target, other]) {
    expect(mock.disks.has(binding.vmId)).toBe(true);
    expect(mock.mounts.has(binding.vmId)).toBe(true);
  }
});
