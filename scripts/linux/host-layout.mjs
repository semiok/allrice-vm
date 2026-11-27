// The MSB v0.7.16 control filename uses 12 digest bytes, encoded as hex.
// Retain Darwin's 104-byte sun_path limit, including NUL, on both platforms.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const capacity = 104;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    value !== '/' &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !value.includes('\0')
  );
}

function checkSocket(path) {
  if (Buffer.byteLength(path, 'utf8') >= capacity)
    throw new Error('Unix socket path exceeds the portable limit');
  return path;
}

/** The platform input belongs to the verified release configuration. The
 * running host can veto a mismatch but cannot select an alternate platform. */
export function resolveHostLayout(config, host) {
  if (
    !['darwin/arm64', 'linux/arm64'].includes(config.platform) ||
    `${host.platform}/${host.arch}` !== config.platform
  )
    throw new Error('Sealed platform does not match the host');

  const socketRoot = config.socketRoot;
  if (
    !isCanonicalAbsolutePath(socketRoot) ||
    (config.platform === 'linux/arm64' && socketRoot !== '/run/ar')
  )
    throw new Error('Invalid platform socket root');

  const controlSocket = (vmId) => {
    if (!uuid.test(vmId)) throw new Error('Invalid MSB socket identity');
    const directoryDigest = createHash('sha256')
      .update('allrice-' + vmId)
      .digest('hex')
      .slice(0, 24);
    return checkSocket(
      posix.join(
        socketRoot,
        vmId,
        'run',
        'sandboxes',
        directoryDigest,
        'control.sock',
      ),
    );
  };

  // Fail at layout construction, before a VM or a private directory is created.
  controlSocket('00000000-0000-0000-0000-000000000000');
  return Object.freeze({ socketRoot, controlSocket });
}
