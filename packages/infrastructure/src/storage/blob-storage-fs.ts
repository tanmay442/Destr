import { promises as fs, createReadStream } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { logger, PayloadTooLargeError, type BlobStorage } from '@app/domain';
import { BLOB_GET_MAX_BYTES } from '@app/infrastructure/config';

export function createFilesystemBlobStorage(maxBytes: number = BLOB_GET_MAX_BYTES): BlobStorage {
  const baseDir = resolve(process.env.BLOB_FS_DIR ?? './.blobs');
  const assertSafeKey = (key: string): string => {
    const full = resolve(baseDir, key);
    if (full !== baseDir && !full.startsWith(baseDir + sep)) {
      throw new Error(`Invalid blob key (path traversal): ${key}`);
    }
    return full;
  };
  const assertSized = (actual: number, key: string): void => {
    if (actual > maxBytes) {
      throw new PayloadTooLargeError(`Blob ${key} is ${actual} bytes (> ${maxBytes})`, actual, maxBytes);
    }
  };
  return {
    async put(key, body, _contentType) {
      void _contentType;
      assertSized(body.byteLength, key);
      const path = assertSafeKey(key);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, body);
    },
    async get(key) {
      const full = assertSafeKey(key);
      const s = await fs.stat(full);
      assertSized(s.size, key);
      return fs.readFile(full);
    },
    async stream(key) {
      const path = assertSafeKey(key);
      const s = await fs.stat(path);
      assertSized(s.size, key);
      const nodeStream = createReadStream(path);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      try {
        await fs.unlink(assertSafeKey(key));
      } catch (e) {
        logger.warn(`[blob-storage] delete failed for ${key}`, { error: e });
      }
    },
  };
}
