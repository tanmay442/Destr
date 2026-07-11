import { promises as fs, createReadStream } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobStorage } from '@app/domain';

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
      return fs.readFile(assertSafeKey(key));
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
