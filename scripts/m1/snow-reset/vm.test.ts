import { expect, it } from 'vitest';
import {
  context,
  harness,
  running,
  signal,
} from '../../../packages/person-vm/src/test-support.ts';

it('rehearses exact-person deleteDisk through PersonVmService, using mock physical resources', async () => {
  const mock = harness();
  const snow = await running(mock);
  const other = context();
  const otherVm = await mock.service.create(other, signal());
  mock.states.set(snow.binding.vmId, 'stopped');

  await expect(
    mock.service.delete(snow.rc, { deleteDisk: true }, signal()),
  ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
  expect(mock.disks.has(snow.binding.vmId)).toBe(true);

  mock.authorizeDiskDelete(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      mock.service.delete(snow.rc, { deleteDisk: true }, signal()),
    ).resolves.toMatchObject({ phase: 'deleted', diskRetained: false });
    expect(mock.disks.has(snow.binding.vmId)).toBe(false);
    expect(mock.mounts.has(snow.binding.vmId)).toBe(false);
    expect(mock.disks.has(otherVm.vmId)).toBe(true);
  }
  expect(mock.log.filter((item) => item === 'disk:delete')).toHaveLength(1);
});
