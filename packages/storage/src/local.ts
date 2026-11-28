import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import {
  ObjectKeySchema,
  StorageObjectSchema,
  UuidSchema,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';

function objectPath(root: string, key: string) {
  const parsed = ObjectKeySchema.parse(key);
  const normalizedRoot = resolve(root);
  const path = resolve(normalizedRoot, parsed);
  if (!path.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('storage key escapes configured root');
  }
  return path;
}

export class LocalStorageAdapter implements StoragePort {
  constructor(private readonly root: string) {
    if (!root.trim()) throw new Error('storage root is required');
  }

  async put(objectInput: StorageObject, content: ReadableStream<Uint8Array>) {
    const object = StorageObjectSchema.parse(objectInput);
    const destination = objectPath(this.root, object.key);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    const reader = content.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        hash.update(chunk.value);
        await handle.writeFile(chunk.value);
      }
      await handle.sync();
      await handle.close();
      const checksum = `sha256:${hash.digest('hex')}`;
      if (size !== object.sizeBytes || checksum !== object.checksum) {
        await rm(temporary, { force: true });
        throw new Error(
          'storage content does not match declared size/checksum',
        );
      }
      await rename(temporary, destination);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async get(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    const handle = await open(objectPath(this.root, object.key), 'r');
    return Readable.toWeb(handle.createReadStream({ highWaterMark: 65536 }), {
      strategy: { highWaterMark: 65536, size: (chunk) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>;
  }

  async delete(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    if (object.immutable)
      throw new Error('immutable storage object cannot be deleted');
    if (
      object.retentionUntil &&
      Date.parse(object.retentionUntil) > Date.now()
    ) {
      throw new Error('storage object is still retained');
    }
    const destination = objectPath(this.root, object.key);
    if (object.deletedAt) {
      // A confirmed metadata tombstone also owns scratch files left by an
      // interrupted put. Remove scratch before the destination so a late
      // rename cannot leave a new final object behind this cleanup.
      const directory = dirname(destination);
      const prefix = basename(destination) + '.';
      try {
        for (const name of await readdir(directory)) {
          if (
            name.startsWith(prefix) &&
            name.endsWith('.tmp') &&
            UuidSchema.safeParse(name.slice(prefix.length, -4)).success
          )
            await rm(join(directory, name), { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rm(destination, { force: true });
  }

  async exists(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    try {
      return (await stat(objectPath(this.root, object.key))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
