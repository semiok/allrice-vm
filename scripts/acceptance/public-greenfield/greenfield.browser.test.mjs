import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { paths } from './contracts.mjs';
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
            {
              status: 200,
              state: 'starting',
              requiredMs: 1000,
              intervalMs: expect.any(Number),
            },
            {
              status: 200,
              state: 'ready',
              requiredMs: 2000,
              intervalMs: expect.any(Number),
            },
          ],
          carrierVerified: true,
          documentVerified: true,
        },
        warm: {
          initialHttp: 204,
          prewarmRequests: 1,
          polls: [],
          carrierVerified: true,
          documentVerified: true,
        },
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
    for (const { intervalMs, requiredMs } of receipt.browser.cold.polls)
      expect(intervalMs).toBeGreaterThanOrEqual(requiredMs - 50);
    for (const key of ['vmId', 'instanceId', 'personId', 'organizationId'])
      expect(result).not.toContain(stop.mock.calls[0][0][key]);
  }, 30_000);

  it.each(['cleanup-unconfirmed', 'cleanup-current-unconfirmed'])(
    'preserves the first terminal poll failure across %s',
    async (code) => {
      const fixture = makeFixture('expired', {
        failCleanup: code === 'cleanup-unconfirmed',
      });
      if (code === 'cleanup-current-unconfirmed') fixture.exactVm = () => null;
      const stop = vi.spyOn(fixture, 'stopExact');
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
        cleanup: { status: 'failed', failure: { code } },
      });
      expect(stop).toHaveBeenCalledTimes(
        code === 'cleanup-unconfirmed' ? 1 : 0,
      );
      expect(recordFirstFailure).toHaveBeenCalledExactlyOnceWith(
        receipt.firstFailure,
      );
    },
    30_000,
  );

  it.each(['instanceId', 'vmId'])(
    'requires actual editability and refuses a replacement %s',
    async (key) => {
      const fixture = makeFixture('locked-editor');
      const exactVm = fixture.exactVm;
      fixture.exactVm = (identity) => ({
        ...exactVm(identity),
        [key]: randomUUID(),
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
          failure: { code: 'cleanup-target-changed' },
        },
      });
      expect(stop).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('rejects a stop reply that identifies a replacement instance', async () => {
    const fixture = makeFixture('locked-editor');
    const stop = fixture.stopExact;
    const stopped = vi
      .spyOn(fixture, 'stopExact')
      .mockImplementation((binding) => ({
        ...stop(binding),
        instanceId: randomUUID(),
      }));
    const receipt = await dryRun({ fixture, browserExecutable });
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { code: 'composer-not-editable' },
      cleanup: { status: 'failed', failure: { code: 'cleanup-unconfirmed' } },
    });
    expect(stopped).toHaveBeenCalledOnce();
  }, 30_000);

  it.each([
    [
      'startup-pending',
      { status: 'failed', failure: { code: 'cleanup-start-pending' } },
    ],
    [
      'startup-unknown',
      { status: 'failed', failure: { code: 'cleanup-start-unconfirmed' } },
    ],
    ['startup-unallocated', { status: 'not-allocated' }],
  ])(
    'accounts for prewarm dispatch on %s before ready',
    async (scenario, cleanup) => {
      const fixture = makeFixture(scenario);
      const current = vi.spyOn(fixture, 'exactVm');
      const stop = vi.spyOn(fixture, 'stopExact');
      const receipt = await dryRun({ fixture, browserExecutable });
      expect(receipt).toMatchObject({
        status: 'failed',
        firstFailure: { code: 'cold-prewarm-http', httpStatus: 503 },
        browser: {
          cold: { prewarmRequests: 1, initialHttp: 503, polls: [] },
          warm: { prewarmRequests: 0 },
        },
        cleanup,
      });
      expect(current).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    },
    30_000,
  );

  it.each([
    ['missing-employee-revision', 'native-identity-scope'],
    ['wrong-employee-version', 'native-identity-scope'],
    ['replaced-document', 'native-document-scope'],
  ])(
    'requires an exact identity and scoped iframe for %s',
    async (scenario, code) => {
      const fixture = makeFixture(scenario);
      const receipt = await dryRun({ fixture, browserExecutable });
      expect(receipt).toMatchObject({
        status: 'failed',
        firstFailure: { code },
        browser: { cold: { prewarmReady: true }, warm: { prewarmRequests: 0 } },
        cleanup: { status: 'stopped' },
      });
      expect(receipt.browser.cold.documentVerified).toBeUndefined();
      if (scenario === 'replaced-document')
        expect(receipt.browser.cold.carrierVerified).toBe(true);
    },
    30_000,
  );

  it('rejects a poll before the phase-specific backoff and records the attempted interval', async () => {
    const fixture = makeFixture('fast-next-poll');
    const request = vi.spyOn(fixture, 'publicHttp');
    const receipt = await dryRun({ fixture, browserExecutable });
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { code: 'poll-too-early' },
      browser: {
        cold: {
          polls: [
            { state: 'starting', requiredMs: 1000 },
            { requiredMs: 2000, intervalMs: expect.any(Number) },
          ],
        },
        warm: { prewarmRequests: 0 },
      },
      cleanup: { status: 'stopped' },
    });
    expect(receipt.browser.cold.polls[1].intervalMs).toBeLessThan(1950);
    expect(
      request.mock.calls.filter(([input]) => input.url.pathname === paths.poll),
    ).toHaveLength(1);
  }, 30_000);

  it('blocks a synthetic prompt attempt before the fixture sees it', async () => {
    const fixture = makeFixture('unexpected-write');
    const request = vi.spyOn(fixture, 'publicHttp');
    const receipt = await dryRun({ fixture, browserExecutable });
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { code: 'write-blocked' },
      browser: { cold: { prewarmRequests: 0 }, warm: { prewarmRequests: 0 } },
      cleanup: { status: 'not-dispatched' },
    });
    expect(
      request.mock.calls.some(([input]) =>
        input.url.pathname.endsWith('/native-rpc'),
      ),
    ).toBe(false);
  }, 30_000);
});
