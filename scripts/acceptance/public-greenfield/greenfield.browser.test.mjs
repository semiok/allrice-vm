import { describe, expect, it, vi } from 'vitest';
import { makeFixture } from './fixture.mjs';
import { dryRun } from './run.mjs';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const browserExecutable =
  process.env.ALLRICE_BROWSER_EXECUTABLE ??
  process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE;

suite('public greenfield offline Chromium', () => {
  it('opens a fresh native editor cold and reopens it once warm', async () => {
    const fixture = makeFixture();
    const stop = vi.spyOn(fixture, 'stopExact');
    const receipt = await dryRun({ fixture, browserExecutable });
    expect(receipt).toMatchObject({
      mode: 'dry-run',
      status: 'passed',
      firstFailure: null,
      stages: {
        adminAccount: 'passed',
        personScopedRelease: 'passed',
        login: 'passed',
        zeroEmployee: 'passed',
        employeeCreation: 'passed',
        coldEditor: 'passed',
        warmEditor: 'passed',
      },
      browser: {
        closed: true,
        cold: {
          initialHttp: 202,
          prewarmRequests: 1,
          polls: [
            { status: 200, state: 'starting' },
            { status: 200, state: 'ready' },
          ],
        },
        warm: { initialHttp: 204, prewarmRequests: 1, polls: [] },
      },
      timings: {
        diskMs: null,
        cacheMs: null,
        vmBootMs: null,
        guestDshReadyMs: null,
        coldPrewarmToReadyObservedMs: expect.any(Number),
        coldToEditableMs: expect.any(Number),
        warmToEditableMs: expect.any(Number),
      },
      cleanup: { status: 'stopped', diskRetained: true, accountRetained: true },
    });
    const result = JSON.stringify(receipt);
    expect(result).not.toContain(fixture.account.password);
    expect(result).not.toContain(fixture.account.username);
    expect(result).not.toContain(fixture.workspaceId);
    expect(stop).toHaveBeenCalledOnce();
  }, 30_000);

  it('preserves the first terminal poll failure across a separate cleanup failure', async () => {
    const fixture = makeFixture('expired', { failCleanup: true });
    const recordFirstFailure = vi.fn();
    const receipt = await dryRun({
      fixture,
      browserExecutable,
      recordFirstFailure,
    });
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { code: 'prewarm-expired', httpStatus: 410 },
      browser: {
        closed: true,
        cold: {
          prewarmRequests: 1,
          polls: [
            { status: 200, state: 'starting' },
            { status: 410, state: 'expired' },
          ],
        },
        warm: { prewarmRequests: 0 },
      },
      cleanup: { status: 'failed', failure: { code: 'cleanup-unconfirmed' } },
    });
    expect(recordFirstFailure).toHaveBeenCalledExactlyOnceWith(
      receipt.firstFailure,
    );
  }, 30_000);

  it('requires actual editability despite ready startup and refuses an unowned cleanup target', async () => {
    const fixture = makeFixture('locked-editor');
    const exactVm = fixture.exactVm;
    fixture.exactVm = (identity) => ({
      ...exactVm(identity),
      organizationId: 'wrong-organization',
    });
    const stop = vi.spyOn(fixture, 'stopExact');
    const receipt = await dryRun({ fixture, browserExecutable });
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { stage: 'coldEditor', code: 'composer-not-editable' },
      browser: {
        closed: true,
        cold: { prewarmReady: true, identityVerified: true },
        warm: { prewarmRequests: 0 },
      },
      cleanup: {
        status: 'failed',
        failure: { code: 'cleanup-target-unverified' },
      },
    });
    expect(stop).not.toHaveBeenCalled();
  }, 30_000);

  it('blocks a synthetic prompt attempt before the fixture sees it', async () => {
    const fixture = makeFixture('unexpected-write');
    const request = vi.spyOn(fixture, 'publicHttp');
    const receipt = await dryRun({ fixture, browserExecutable });
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { code: 'write-blocked' },
      browser: { cold: { prewarmRequests: 0 }, warm: { prewarmRequests: 0 } },
      cleanup: { status: 'vm-not-observed' },
    });
    expect(
      request.mock.calls.some(([input]) =>
        input.url.pathname.endsWith('/native-rpc'),
      ),
    ).toBe(false);
  }, 30_000);
});
