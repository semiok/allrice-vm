import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveHostLayout } from './host-layout.mjs';

const vm = 'c38fff6e-7ef5-49e5-b01e-b8dfbe604753';
const hash = 'a'.repeat(24);
const linux = { platform: 'linux', arch: 'arm64', socketRoot: '/run/ar' };
const darwin = { platform: 'darwin', arch: 'arm64', socketRoot: '/tmp/ar' };

test('selects the sealed Linux path, preserving the existing Mac suffix and input', () => {
  const suffix = `/${vm}/run/sandboxes/${hash}/control.sock`;
  assert.equal(resolveHostLayout(linux, linux).controlSocket(vm, hash), '/run/ar' + suffix);
  assert.equal(resolveHostLayout(darwin, darwin).controlSocket(vm, hash), '/tmp/ar' + suffix);
});
test('uses UTF-8 bytes and reserves the terminating NUL on both platforms', () => {
  const max = { ...darwin, socketRoot: '/中文1234567' };
  const path = resolveHostLayout(max, darwin).controlSocket(vm, hash);
  assert.equal(Buffer.byteLength(path), 103);
  assert.throws(() => resolveHostLayout({ ...max, socketRoot: '/中文12345678' }, darwin), /portable limit/);
});
test('rejects mismatch, unsealed fallback, path aliases and unsafe identities', () => {
  assert.throws(() => resolveHostLayout(linux, darwin), /host/);
  assert.throws(() => resolveHostLayout({ arch: 'arm64' }, linux), /host/);
  assert.throws(() => resolveHostLayout(linux, { ...linux, arch: 'x64' }), /host/);
  for (const socketRoot of ['/run/other', '/run/./ar', '/run/ar/', '/run//ar', 'run/ar'])
    assert.throws(() => resolveHostLayout({ ...linux, socketRoot }, linux), /socket root/);
  const layout = resolveHostLayout(linux, linux);
  assert.throws(() => layout.controlSocket('../other', hash), /identity/);
  assert.throws(() => layout.controlSocket(vm, '../other'), /identity/);
});
