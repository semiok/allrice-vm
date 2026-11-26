import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { resolveHostLayout } from './host-layout.mjs';

const vm = 'c38fff6e-7ef5-49e5-b01e-b8dfbe604753';
const hash = createHash('sha256')
  .update('allrice-' + vm)
  .digest('hex')
  .slice(0, 24);
const linux = { platform: 'linux/arm64', socketRoot: '/run/ar' };
const darwin = { platform: 'darwin/arm64', socketRoot: '/tmp/ar' };
const linuxHost = { platform: 'linux', arch: 'arm64' };
const macHost = { platform: 'darwin', arch: 'arm64' };

test('selects the sealed Linux path, preserving the existing Mac suffix and input', () => {
  const suffix = `/${vm}/run/sandboxes/${hash}/control.sock`;
  const linuxLayout = resolveHostLayout(linux, linuxHost);
  assert.equal(linuxLayout.controlSocket(vm), '/run/ar' + suffix);
  assert.equal(Buffer.byteLength(linuxLayout.controlSocket(vm)), 96);
  const macLayout = resolveHostLayout(
    { ...darwin, socketRoot: '/tmp/ar/' },
    macHost,
  );
  assert.equal(macLayout.socketRoot, '/tmp/ar/');
  assert.equal(macLayout.controlSocket(vm), '/tmp/ar' + suffix);
});

test('uses UTF-8 bytes and reserves the terminating NUL on both platforms', () => {
  const max = { ...darwin, socketRoot: '/中文1234567' };
  const path = resolveHostLayout(max, macHost).controlSocket(vm);
  assert.equal(Buffer.byteLength(path), 103);
  assert.throws(
    () => resolveHostLayout({ ...max, socketRoot: '/中文12345678' }, macHost),
    /portable limit/,
  );
});

test('rejects mismatch, unsealed fallback, path aliases and unsafe identities', () => {
  assert.throws(() => resolveHostLayout(linux, macHost), /host/);
  assert.throws(() => resolveHostLayout({}, linuxHost), /host/);
  assert.throws(
    () => resolveHostLayout(linux, { ...linuxHost, arch: 'x64' }),
    /host/,
  );
  for (const socketRoot of [
    '/run/other',
    '/run/./ar',
    '/run/ar/',
    '/run//ar',
    'run/ar',
  ])
    assert.throws(
      () => resolveHostLayout({ ...linux, socketRoot }, linuxHost),
      /socket root/,
    );
  assert.throws(
    () => resolveHostLayout(linux, linuxHost).controlSocket('../other'),
    /identity/,
  );
});
