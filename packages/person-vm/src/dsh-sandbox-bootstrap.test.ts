import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, test } from 'vitest';
import {
  DSH_SANDBOX_ROOT,
  prepareDshSandbox,
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

test('records the source mount and atomically stages and reuses the exact readonly executable', () => {
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
  expect(fs.lstatSync(f.final).ino).toBe(stat.ino);
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
