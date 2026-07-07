import { promises as fs, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobStorage } from '@app/domain';

export function createFilesystemBlobStorage(): BlobStorage {
  const baseDir = process.env.BLOB_FS_DIR ?? './.blobs';
  return {
    async put(key, body) {
      const path = join(baseDir, key);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, body);
    },
    async get(key) {
      return fs.readFile(join(baseDir, key));
    },
    async stream(key) {
      const path = join(baseDir, key);
      const nodeStream = createReadStream(path);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      await fs.unlink(join(baseDir, key)).catch(() => {});
    },
  };
}
