import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundError } from '@app/domain';
import { createFilesystemBlobStorage } from '../../blob-storage-fs';
import { runBlobStorageContract } from './blob-storage-contract';

describe('filesystem blob storage contract', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'blob-contract-'));
    process.env.BLOB_FS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.BLOB_FS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  runBlobStorageContract(
    (opts) => createFilesystemBlobStorage(opts?.maxBytes),
    { supportsSignedUrl: false },
  );

  it('fails closed with NotFoundError on missing and empty blobs', async () => {
    const storage = createFilesystemBlobStorage();
    await expect(storage.get('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(storage.stream('missing')).rejects.toBeInstanceOf(NotFoundError);
    await storage.put('empty', Buffer.alloc(0), 'application/octet-stream');
    await expect(storage.get('empty')).rejects.toBeInstanceOf(NotFoundError);
    await expect(storage.stream('empty')).rejects.toBeInstanceOf(NotFoundError);
  });
});
