import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  SandboxNetworkLeaseSchema,
  type SandboxNetworkLease,
  type SandboxNetworkErrorCode,
} from '@allrice/contracts';
import { resolvePublicAddress } from './public-address.js';

export class SandboxNetworkError extends Error {
  constructor(readonly code: SandboxNetworkErrorCode) {
    super(code);
  }
}
const denied4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied4.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied6.addSubnet(address, prefix, 'ipv6');

export function sandboxPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  if (isIP(address) === 4) return !denied4.check(address, 'ipv4');
  return (
    isIP(address) === 6 &&
    global6.check(address, 'ipv6') &&
    !denied6.check(address, 'ipv6')
  );
}

export function assertSandboxDestination(
  lease: SandboxNetworkLease,
  hostname: string,
  now = Date.now(),
) {
  if (Date.parse(lease.expiresAt) <= now)
    throw new SandboxNetworkError('SANDBOX_NETWORK_REVOKED');
  if (!lease.network.origins.includes(`https://${hostname}`))
    throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
}

/** Resolve on every connection, then connect to this literal without a second
 * lookup. Private/mixed answers and aliases of this host remain denied. */
export async function resolveSandboxDestination(
  leaseInput: SandboxNetworkLease,
  hostname: string,
) {
  const lease = SandboxNetworkLeaseSchema.parse(leaseInput);
  assertSandboxDestination(lease, hostname);
  const own = new Set(
    Object.values(networkInterfaces()).flatMap(
      (items) => items?.map((item) => item.address) ?? [],
    ),
  );
  try {
    const address = await resolvePublicAddress(
      hostname,
      (ip) => sandboxPublicAddress(ip) && !own.has(ip),
    );
    assertSandboxDestination(lease, hostname);
    return address;
  } catch (error) {
    if (error instanceof SandboxNetworkError) throw error;
    if (error instanceof Error && error.message === 'PUBLIC_ADDRESS_DENIED')
      throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
    throw new SandboxNetworkError('SANDBOX_NETWORK_DNS');
  }
}

const maxHelloWireBytes = 65_536;

function invalidTlsHello(): never {
  throw new SandboxNetworkError('SANDBOX_NETWORK_PROTOCOL');
}

/** Validate a complete initial TLS ClientHello before any tenant bytes leave
 * the broker. No raw TCP, alternate SNI or encrypted ClientHello routing. */
export function sandboxTlsClientHello(
  bytes: Buffer,
  hostname: string,
): 'pending' | 'valid' {
  if (bytes.length > maxHelloWireBytes) invalidTlsHello();
  return createTlsHelloReader(hostname, false)(bytes) ? 'valid' : 'pending';
}

/** Return the validated ClientHello boundary, independent of TCP chunking. */
export function sandboxPublicTlsClientHello(bytes: Buffer, hostname: string) {
  return createSandboxPublicTlsClientHelloReader(hostname)(bytes);
}

/** Accept each successive socket chunk once, through the first ClientHello. */
export function createSandboxPublicTlsClientHelloReader(hostname: string) {
  return createTlsHelloReader(hostname, true);
}

function createTlsHelloReader(hostname: string, publicProxy: boolean) {
  const recordHeader = Buffer.alloc(5);
  const helloHeader = Buffer.alloc(4);
  let recordHeaderSize = 0;
  let recordRemaining = 0;
  let wireEnd = 0;
  let helloSize = 0;
  let expectedSize = 0;
  const hello: Buffer[] = [helloHeader];

  return (bytes: Buffer) => {
    let offset = 0;
    while (offset < bytes.length) {
      if (recordRemaining === 0) {
        const size = Math.min(
          recordHeader.length - recordHeaderSize,
          bytes.length - offset,
        );
        bytes.copy(recordHeader, recordHeaderSize, offset, offset + size);
        recordHeaderSize += size;
        offset += size;
        if (recordHeaderSize < recordHeader.length) return null;
        recordHeaderSize = 0;
        const length = recordHeader.readUInt16BE(3);
        wireEnd += recordHeader.length + length;
        if (
          recordHeader[0] !== 22 ||
          recordHeader[1] !== 3 ||
          recordHeader[2]! > 3 ||
          length === 0 ||
          length > 18_432 ||
          wireEnd > maxHelloWireBytes
        )
          invalidTlsHello();
        recordRemaining = length;
      }

      if (!expectedSize) {
        const size = Math.min(
          helloHeader.length - helloSize,
          recordRemaining,
          bytes.length - offset,
        );
        bytes.copy(helloHeader, helloSize, offset, offset + size);
        helloSize += size;
        recordRemaining -= size;
        offset += size;
        if (helloSize < helloHeader.length) continue;
        const length = helloHeader.readUIntBE(1, 3);
        if (helloHeader[0] !== 1 || length > 60_000) invalidTlsHello();
        expectedSize = helloHeader.length + length;
      }

      // Reject a record extending past ClientHello, even if it is incomplete.
      if (recordRemaining > expectedSize - helloSize) invalidTlsHello();
      const size = Math.min(recordRemaining, bytes.length - offset);
      if (size) hello.push(bytes.subarray(offset, offset + size));
      helloSize += size;
      recordRemaining -= size;
      offset += size;
      if (helloSize === expectedSize) {
        if (!publicProxy && offset !== bytes.length) invalidTlsHello();
        return {
          end: wireEnd,
          earlyData: validateTlsHello(
            Buffer.concat(hello, expectedSize),
            hostname,
            publicProxy,
          ),
        };
      }
    }
    return null;
  };
}

function validateTlsHello(
  body: Buffer,
  hostname: string,
  publicProxy: boolean,
) {
  let p = 4;
  const take = (count: number) => {
    const start = p;
    p += count;
    if (p > body.length) invalidTlsHello();
    return start;
  };
  const u16 = () => body.readUInt16BE(take(2));
  take(34);
  take(body[take(1)]!);
  const ciphers = u16();
  if (ciphers < 2 || ciphers % 2) return invalidTlsHello();
  take(ciphers);
  take(body[take(1)]!);
  const extensionSize = u16();
  if (p + extensionSize !== body.length) return invalidTlsHello();
  let sni: string | undefined;
  const seen = new Set<number>();
  while (p < body.length) {
    const type = u16(),
      length = u16(),
      end = p + length;
    if (end > body.length || seen.has(type) || type === 0xfe0d)
      return invalidTlsHello();
    seen.add(type);
    if (type === 0) {
      if (u16() !== length - 2 || body[take(1)] !== 0) return invalidTlsHello();
      const nameLength = u16(),
        name = body.subarray(take(nameLength), p);
      if (
        p !== end ||
        (publicProxy
          ? name.toString('ascii').toLowerCase() !== hostname.toLowerCase()
          : !name.equals(Buffer.from(hostname, 'ascii')))
      )
        return invalidTlsHello();
      sni = name.toString('ascii');
    } else if (publicProxy && type === 16) {
      if (length < 3 || u16() !== length - 2) return invalidTlsHello();
      while (p < end) {
        const protocolLength = body[take(1)]!;
        const protocol = body
          .subarray(take(protocolLength), p)
          .toString('ascii');
        if (!['http/1.0', 'http/1.1', 'h2'].includes(protocol))
          return invalidTlsHello();
      }
      if (p !== end) return invalidTlsHello();
    } else if (publicProxy && type === 42) {
      if (length !== 0) return invalidTlsHello();
    } else p = end;
  }
  if (sni === undefined && !(publicProxy && isIP(hostname)))
    return invalidTlsHello();
  return seen.has(41) && seen.has(42);
}
