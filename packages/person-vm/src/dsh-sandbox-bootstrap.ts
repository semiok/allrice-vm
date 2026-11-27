export const DSH_SANDBOX_ROOT = '/usr/local/lib/allrice-sandbox';

// agentd prepends its scripts directory to the environment it receives.
// Replace PATH inside the guest, then exec the fixed Node binary in place.
export const launchDshSandbox = 'PATH="$1"; export PATH; shift; exec "$@"';

// This wrapper runs after the sealed memory launcher and reads data only.
export const launchDshPublicProxy = String.raw`
set -eu
{
  IFS= read -r proxy_url
  IFS= read -r proxy_bypass
} < "$ALLRICE_PUBLIC_PROXY_CONFIG"
export http_proxy="$proxy_url" HTTP_PROXY="$proxy_url"
export https_proxy="$proxy_url" HTTPS_PROXY="$proxy_url"
export no_proxy="localhost,127.0.0.1,[::1],$proxy_bypass"
export NO_PROXY="$no_proxy"
exec "$@"
`;

/** Run inside the VM over the existing managed bootstrap job protocol. */
export const prepareDshSandbox = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const [source, sha256] = process.argv.slice(1);
const base = '${DSH_SANDBOX_ROOT}';
const uid = 0;
const limit = 128 * 1024;
if (!/^\/opt\/allrice\/dsh\/[a-f0-9]{64}$/.test(source) ||
    !/^[a-f0-9]{64}$/.test(sha256)) throw Error('invalid-dsh-sandbox-input');

const mount = fs.readFileSync('/proc/mounts', 'utf8').split('\n')
  .map(line => line.split(' ')).filter(fields => fields[1] === source);
if (mount.length !== 1 || !mount[0][3].split(',').includes('ro'))
  throw Error('untrusted-dsh-sandbox-source-mount');
console.log(JSON.stringify({ mount: source, type: mount[0][2], options: mount[0][3] }));

const readVerified = (file, copied) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit ||
        (copied && (stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o555)))
      throw Error('untrusted-dsh-sandbox-file');
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size || crypto.createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw Error('dsh-sandbox-digest-mismatch');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
};

function directory(dir, create) {
  if (create) {
    try {
      fs.mkdirSync(dir, {mode: 0o755});
      fs.chmodSync(dir, 0o755);
    }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || fs.realpathSync(dir) !== dir ||
      (create ? (stat.mode & 0o7777) !== 0o755 : (stat.mode & 0o022) !== 0))
    throw Error('untrusted-dsh-sandbox-directory');
}

const bytes = readVerified(source + '/sandbox-bin/bwrap', false);
let ancestor = path.dirname(base);
while (ancestor !== '/') {
  directory(ancestor, false);
  ancestor = path.dirname(ancestor);
}
directory(base, true);
const destination = base + '/' + sha256;
directory(destination, true);
const target = destination + '/bwrap';
const entries = fs.readdirSync(destination);
if (entries.length > 0 && (entries.length !== 1 || entries[0] !== 'bwrap'))
  throw Error('untrusted-dsh-sandbox-directory-entries');
if (entries.length === 1) readVerified(target, true);

// Publish a fresh inode every time. The cache's existing bytes and mode
// cannot establish the absence of extended attributes such as file capabilities.
const staging = fs.mkdtempSync(base + '/.bwrap-');
const temp = staging + '/bwrap';
try {
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, 0o555);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);
} finally {
  try { fs.unlinkSync(temp); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { fs.rmdirSync(staging); }
}
readVerified(target, true);
`;

/** Verify the active block mount in the guest without writing to it. The
 * publisher and sealed disk checksum authenticate the underlying image. */
export const verifyDshRuntimeDisk = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const [source, bwrapSha256, cliSha256] = process.argv.slice(1);
if (!/^\/opt\/allrice\/dsh\/[a-f0-9]{64}$/.test(source) ||
    ![bwrapSha256, cliSha256].every(hash => /^[a-f0-9]{64}$/.test(hash)))
  throw Error('invalid-dsh-runtime-disk-input');

const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
  .map(line => line.split(' - ').map(part => part.split(' ')));
const matching = mounts.filter(([local]) =>
  local[4] === source || local[4]?.startsWith(source + '/'));
if (matching.length !== 1) throw Error('untrusted-dsh-runtime-disk-mount');
const [local, filesystem] = matching[0];
const options = local[5]?.split(',');
if (local[4] !== source || local[3] !== '/' || !options?.includes('ro') ||
    options.includes('noexec') || filesystem?.[0] !== 'ext4' ||
    !/^\/dev\/vd[a-z]+$/.test(filesystem[1]) ||
    !filesystem[2]?.split(',').includes('ro') ||
    fs.realpathSync(source) !== source)
  throw Error('untrusted-dsh-runtime-disk-mount');

const device = fs.statSync(source).dev;
function verify(path, expected) {
  if (fs.realpathSync(path) !== path) throw Error('untrusted-dsh-runtime-disk-file');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.dev !== device ||
        (stat.mode & 0o7777) !== 0o555 || stat.size <= 0 || stat.size > 4 * 1024 * 1024)
      throw Error('untrusted-dsh-runtime-disk-file');
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size || crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
      throw Error('dsh-runtime-disk-digest-mismatch');
  } finally {
    fs.closeSync(fd);
  }
}
verify(source + '/sandbox-bin/bwrap', bwrapSha256);
verify(source + '/node_modules/@deepseek-ai/dsh/lib/bin.js', cliSha256);
`;
