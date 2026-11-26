// The MSB v0.7.16 control filename uses 12 digest bytes, encoded as hex.
// Retain Darwin's 104-byte sun_path limit, including NUL, on both platforms.
import { posix } from 'node:path';

const capacity = 104;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{24}$/;

export function isCanonicalAbsolutePath(value) {
  return typeof value === 'string' &&
    value !== '/' &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !value.endsWith('/') &&
    !value.includes('\0');
}

function checkSocket(path) {
  if (Buffer.byteLength(path, 'utf8') >= capacity)
    throw new Error('Unix socket path exceeds the portable limit');
  return path;
}

/** The platform input belongs to the verified release configuration. The
 * running host can veto a mismatch but cannot select an alternate platform. */
export function resolveHostLayout(config, host) {
  if (!['darwin', 'linux'].includes(config.platform) ||
      config.arch !== 'arm64' ||
      host.platform !== config.platform ||
      host.arch !== config.arch)
    throw new Error('Sealed platform does not match the host');

  const socketRoot = config.socketRoot;
  if (!isCanonicalAbsolutePath(socketRoot) ||
      (config.platform === 'linux' && socketRoot !== '/run/ar'))
    throw new Error('Invalid platform socket root');

  const controlSocket = (vmId, directoryDigest) => {
    if (!uuid.test(vmId) || !digest.test(directoryDigest))
      throw new Error('Invalid MSB socket identity');
    return checkSocket(posix.join(
      socketRoot, vmId, 'run', 'sandboxes', directoryDigest, 'control.sock',
    ));
  };

  // Fail at layout construction, before a VM or a private directory is created.
  controlSocket('00000000-0000-0000-0000-000000000000', '0'.repeat(24));
  return Object.freeze({ socketRoot, controlSocket });
}
