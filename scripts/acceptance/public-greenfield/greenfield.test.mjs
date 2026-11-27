import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { livePreflight } from './contracts.mjs';
import { makeFixture } from './fixture.mjs';
import { dryRun } from './run.mjs';

describe('public greenfield preflight', () => {
  it('requires both the explicit write flag and a complete source SHA and tree', () => {
    const git = vi.fn();
    expect(
      livePreflight({ allowPublicWrites: true, releaseSha: '83f9458b' }, git),
    ).toMatchObject({
      requestedRelease: null,
      localRef: null,
      blockers: ['explicit-live-approval-and-exact-release-required'],
    });
    expect(git).not.toHaveBeenCalled();
  });

  it('keeps live blocked without managed owner cleanup even when source gates pass', () => {
    const releaseSha = 'a'.repeat(40);
    const releaseTree = 'b'.repeat(40);
    const git = ([command, , ref]) =>
      command === 'rev-parse'
        ? ref.endsWith('{tree}')
          ? releaseTree
          : releaseSha
        : '';
    expect(
      livePreflight({ allowPublicWrites: true, releaseSha, releaseTree }, git),
    ).toMatchObject({
      requestedRelease: { sha: releaseSha, tree: releaseTree },
      localRef: {
        name: 'refs/remotes/origin/main',
        sha: releaseSha,
        tree: releaseTree,
      },
      blockers: ['managed-exact-owner-stop-unavailable'],
    });
  });

  it('writes a blocked CLI receipt with exact comparison inputs and omits malformed input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'greenfield-cli-test-'));
    const name = 'refs/remotes/origin/main';
    const git = (revision) =>
      execFileSync('git', ['rev-parse', '--verify', revision], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    let localRef = null;
    try {
      const sha = git(name + '^{commit}');
      localRef = { name, sha, tree: git(sha + '^{tree}') };
    } catch {
      // Shallow PR CI need not have a local origin/main ref.
    }
    const invoke = (id, sha, tree) => {
      const output = join(dir, id);
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./run.mjs', import.meta.url)),
          '--live',
          '--allow-public-writes',
          '--release-sha',
          sha,
          '--release-tree',
          tree,
          '--output',
          output,
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      expect(child.status).toBe(2);
      const raw = readFileSync(join(output, 'receipt.json'), 'utf8');
      return {
        raw,
        json: JSON.parse(raw),
        stdout: child.stdout,
        stderr: child.stderr,
      };
    };
    try {
      const sha = 'a'.repeat(40);
      const tree = 'b'.repeat(40);
      const complete = invoke('complete', sha, tree);
      expect(complete.json).toMatchObject({
        mode: 'live',
        status: 'blocked',
        requestedRelease: { sha, tree },
        localRef,
      });
      expect(complete.json.blockers).toContain(
        localRef
          ? 'local-origin-main-release-mismatch'
          : 'repository-release-unavailable',
      );
      const malformed = 'synthetic-invalid-argument';
      const invalid = invoke('invalid', malformed, tree);
      expect(invalid.json).toMatchObject({
        requestedRelease: null,
        localRef: null,
        blockers: ['explicit-live-approval-and-exact-release-required'],
      });
      expect(invalid.raw + invalid.stdout + invalid.stderr).not.toContain(
        malformed,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
