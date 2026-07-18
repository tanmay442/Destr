import { promises as fs, createReadStream } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { BLOB_GET_MAX_BYTES, PayloadTooLargeError, type BlobStorage } from '@app/domain';

export function createFilesystemBlobStorage(): BlobStorage {
  const baseDir = resolve(process.env.BLOB_FS_DIR ?? './.blobs');
  const assertSafeKey = (key: string): string => {
    const full = resolve(baseDir, key);
    if (full !== baseDir && !full.startsWith(baseDir + sep)) {
      throw new Error(`Invalid blob key (path traversal): ${key}`);
    }
    return full;
  };
  return {
    async put(key, body) {
      const path = assertSafeKey(key);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, body);
    },
    async get(key) {
      const full = assertSafeKey(key);
      const s = await fs.stat(full);
      if (s.size > BLOB_GET_MAX_BYTES) {
        throw new PayloadTooLargeError(`Blob ${key} is ${s.size} bytes (> ${BLOB_GET_MAX_BYTES})`, s.size, BLOB_GET_MAX_BYTES);
      }
      return fs.readFile(full);
    },
    async stream(key) {
      const path = assertSafeKey(key);
      const nodeStream = createReadStream(path);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      await fs.unlink(assertSafeKey(key)).catch(() => {});
    },
  };
}
