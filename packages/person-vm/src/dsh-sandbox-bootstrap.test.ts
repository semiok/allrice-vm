import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, test } from 'vitest';
import {
  DSH_SANDBOX_ROOT,
  launchDshPublicProxy,
  launchDshSandbox,
  prepareDshSandbox,
  verifyDshRuntimeDisk,
} from './dsh-sandbox-bootstrap.ts';

const require = createRequire(import.meta.url);
const source = '/opt/allrice/dsh/' + 'a'.repeat(64);
const bytes = Buffer.from('trusted bwrap fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/dsh-sandbox-'));
  roots.push(root);
  const input = join(root, 'source');
  fs.writeFileSync(input, bytes, { mode: 0o555 });
  const base = join(root, 'allrice-sandbox');
  const destination = join(base, sha256);
  const final = join(destination, 'bwrap');
  const observed: string[] = [];
  const uid = process.getuid!();
  function run(options: { mount?: string; digest?: string } = {}) {
    const guestFs = {
      ...fs,
      readFileSync: (filename: string | number, encoding: BufferEncoding) =>
        filename === '/proc/mounts'
          ? 'source ' +
            source +
            ' virtiofs ' +
            (options.mount ?? 'ro,noexec') +
            ' 0 0\n'
          : fs.readFileSync(filename, encoding),
      lstatSync: (path: string) => {
        const stat = fs.lstatSync(path);
        if (path === root || root.startsWith(path + '/')) {
          stat.uid = uid;
          stat.mode &= ~0o022;
        }
        return stat;
      },
      openSync: (path: string, flags: number, mode: number) =>
        fs.openSync(
          path === source + '/sandbox-bin/bwrap' ? input : path,
          flags,
          mode,
        ),
    };
    runInNewContext(
      prepareDshSandbox
        .replace(DSH_SANDBOX_ROOT, base)
        .replace('const uid = 0;', 'const uid = ' + uid + ';'),
      {
        require: (id: string) => (id === 'node:fs' ? guestFs : require(id)),
        process: { argv: ['node', source, options.digest ?? sha256] },
        console: { log: (row: string) => observed.push(row) },
      },
    );
  }
  return { run, input, root, base, destination, final, observed };
}

test('records the source mount and stages verified bytes on a fresh executable inode', () => {
  const f = setup();
  f.run();
  expect(JSON.parse(f.observed[0]!)).toEqual({
    mount: source,
    type: 'virtiofs',
    options: 'ro,noexec',
  });
  expect(fs.readFileSync(f.final)).toEqual(bytes);
  const stat = fs.lstatSync(f.final);
  expect(stat.mode & 0o7777).toBe(0o555);
  expect(stat.nlink).toBe(1);
  expect(fs.lstatSync(dirname(f.final)).mode & 0o7777).toBe(0o755);
  expect(fs.readdirSync(f.destination)).toEqual(['bwrap']);
  f.run();
  // Filesystem capability attributes are associated with the old inode.
  expect(fs.lstatSync(f.final).ino).not.toBe(stat.ino);
  expect(fs.readFileSync(f.final)).toEqual(bytes);
});

test('requires a readonly source mount and a verified source before touching the destination', () => {
  const f = setup();
  expect(() => f.run({ mount: 'rw' })).toThrow(
    'untrusted-dsh-sandbox-source-mount',
  );
  expect(() => f.run({ digest: 'b'.repeat(64) })).toThrow(
    'dsh-sandbox-digest-mismatch',
  );
  expect(fs.existsSync(f.base)).toBe(false);
});

test('refuses a redirected or replaced executable at the destination', () => {
  const f = setup();
  f.run();
  fs.unlinkSync(f.final);
  fs.symlinkSync(f.input, f.final);
  expect(() => f.run()).toThrow();
  expect(fs.lstatSync(f.final).isSymbolicLink()).toBe(true);
  fs.unlinkSync(f.final);
  fs.writeFileSync(f.final, 'tampered', { mode: 0o555 });
  expect(() => f.run()).toThrow('dsh-sandbox-digest-mismatch');
  expect(fs.readFileSync(f.final, 'utf8')).toBe('tampered');
});

test('refuses extra programs in a retained PATH directory', () => {
  const f = setup();
  f.run();
  const old = fs.lstatSync(f.final);
  fs.writeFileSync(join(f.destination, 'node'), '#!/bin/sh\nexit 1\n', {
    mode: 0o555,
  });
  expect(() => f.run()).toThrow('untrusted-dsh-sandbox-directory-entries');
  expect(fs.lstatSync(f.final).ino).toBe(old.ino);
});

test('sets the actual Node process PATH after the agentd environment prefix', () => {
  const f = setup();
  f.run();
  const prefix = join(f.root, 'agentd-scripts');
  fs.mkdirSync(prefix);
  fs.writeFileSync(join(prefix, 'bwrap'), '#!/bin/sh\nexit 1\n', {
    mode: 0o555,
  });
  const path = f.destination + ':/usr/bin:/bin';
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      launchDshSandbox,
      'allrice-dsh',
      path,
      process.execPath,
      '-e',
      "const check = require('node:child_process').spawnSync('/bin/sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }); console.log(JSON.stringify([process.env.PATH, check.stdout.trim()]));",
    ],
    { encoding: 'utf8', env: { PATH: prefix + ':' + path } },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([path, f.final]);
});

test('loads the proxy environment from a private file after the original guest launcher', () => {
  const f = setup();
  const config = join(f.root, 'proxy.conf');
  const proxy = 'http://vm-proxy:synthetic@172.16.0.5:34567/';
  fs.writeFileSync(config, proxy + '\n172.16.0.5\n', { mode: 0o600 });
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      launchDshPublicProxy,
      'allrice-public-proxy',
      '/bin/sh',
      '-c',
      'test "$http_proxy" = "$HTTP_PROXY" && test "$https_proxy" = "$HTTPS_PROXY" && printf "%s\\n%s\\n" "$https_proxy" "$NO_PROXY"',
    ],
    { encoding: 'utf8', env: { ALLRICE_PUBLIC_PROXY_CONFIG: config } },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    proxy + '\nlocalhost,127.0.0.1,[::1],172.16.0.5\n',
  );
});

test('checks the live ext4 mount and verifies both directly executed files', () => {
  const f = setup();
  const cli = '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const mount =
    '38 30 254:16 / ' + source + ' ro,relatime - ext4 /dev/vdb ro,norecovery';
  const verify = (row: string, cliHash = sha256, redirect = false) =>
    runInNewContext(verifyDshRuntimeDisk, {
      require: (id: string) =>
        id !== 'node:fs'
          ? require(id)
          : {
              ...fs,
              readFileSync: (
                path: string | number,
                encoding: BufferEncoding,
              ) =>
                path === '/proc/self/mountinfo'
                  ? row
                  : fs.readFileSync(path, encoding),
              openSync: (path: string, flags: number) => {
                expect(path).toMatch(
                  new RegExp(
                    '^' + source + '(/sandbox-bin/bwrap|' + cli + ')$',
                  ),
                );
                return fs.openSync(f.input, flags);
              },
              realpathSync: (path: string) =>
                redirect && path.endsWith(cli) ? f.input : path,
              statSync: () => fs.statSync(f.input),
              fstatSync: (fd: number) =>
                Object.assign(fs.fstatSync(fd), { uid: 0 }),
            },
      process: { argv: ['node', source, sha256, cliHash] },
    });
  expect(() => verify(mount)).not.toThrow();
  expect(() => verify(mount.replace('ro,relatime', 'rw,relatime'))).toThrow(
    'untrusted-dsh-runtime-disk-mount',
  );
  expect(() => verify(mount.replace('ro,relatime', 'ro,noexec'))).toThrow(
    'untrusted-dsh-runtime-disk-mount',
  );
  expect(() => verify(mount.replace('ext4', 'virtiofs'))).toThrow(
    'untrusted-dsh-runtime-disk-mount',
  );
  expect(() =>
    verify(mount + '\n' + mount.replace(source, source + '/sandbox-bin')),
  ).toThrow('untrusted-dsh-runtime-disk-mount');
  expect(() => verify(mount, 'b'.repeat(64))).toThrow(
    'dsh-runtime-disk-digest-mismatch',
  );
  expect(() => verify(mount, sha256, true)).toThrow(
    'untrusted-dsh-runtime-disk-file',
  );
});
