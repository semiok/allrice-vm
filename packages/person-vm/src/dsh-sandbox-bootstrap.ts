export const DSH_SANDBOX_ROOT = '/usr/local/lib/allrice-sandbox';

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
try {
  readVerified(target, true);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const staging = fs.mkdtempSync(destination + '/.bwrap-');
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
    // Atomic publication without exposing a target with two hard links if
    // the guest stops between publication and temporary-file cleanup.
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { fs.rmdirSync(staging); }
  }
  readVerified(target, true);
}
`;
