import { describe, expect, it, vi } from 'vitest';
import { liveBlockers } from './contracts.mjs';
import { makeFixture } from './fixture.mjs';
import { dryRun } from './run.mjs';

describe('public greenfield preflight', () => {
  it('requires both the explicit write flag and a complete source SHA and tree', () => {
    const git = vi.fn();
    expect(
      liveBlockers({ allowPublicWrites: true, releaseSha: '83f9458b' }, git),
    ).toEqual(['explicit-live-approval-and-exact-release-required']);
    expect(git).not.toHaveBeenCalled();
  });

  it('keeps live blocked without managed owner cleanup even when source gates pass', () => {
    const releaseSha = 'a'.repeat(40);
    const releaseTree = 'b'.repeat(40);
    const git = ([command, ref]) =>
      command === 'rev-parse'
        ? ref.endsWith('{tree}')
          ? releaseTree
          : releaseSha
        : '';
    expect(
      liveBlockers({ allowPublicWrites: true, releaseSha, releaseTree }, git),
    ).toEqual(['managed-exact-owner-stop-unavailable']);
  });

  it('preserves a verified-service identity mismatch before account creation', async () => {
    const fixture = makeFixture();
    const health = fixture.health;
    fixture.health = (service) => {
      const response = health(service);
      if (service === 'worker')
        response.body.identity.sourceTree = 'c'.repeat(40);
      return response;
    };
    const admin = vi.spyOn(fixture, 'adminHttp');
    const recordFirstFailure = vi.fn();
    const receipt = await dryRun({ fixture, recordFirstFailure });
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: {
        stage: 'releaseBefore',
        code: 'release-identity-mismatch',
        httpStatus: 200,
      },
    });
    expect(recordFirstFailure).toHaveBeenCalledExactlyOnceWith(
      receipt.firstFailure,
    );
    expect(admin).not.toHaveBeenCalled();
  });
});
