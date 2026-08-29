import { promises as fs, constants } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { logger, NotFoundError, PayloadTooLargeError, type BlobStorage } from '@app/domain';
import { BLOB_GET_MAX_BYTES } from '@app/infrastructure/config';
import { registerBlobStorageProvider } from './blob-storage-registry';

export function createFilesystemBlobStorage(maxBytes: number = BLOB_GET_MAX_BYTES): BlobStorage {
  const boundedMaxBytes = Math.max(1, Math.floor(maxBytes));
  const baseDir = resolve(process.env.BLOB_FS_DIR ?? './.blobs');
  const assertBaseDirNotSymlink = async (): Promise<void> => {
    try {
      const stat = await fs.lstat(baseDir);
      if (stat.isSymbolicLink()) throw new Error(`Blob baseDir is a symlink: ${baseDir}`);
      if (!stat.isDirectory()) throw new Error(`Blob baseDir is not a directory: ${baseDir}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw e;
    }
  };
  const assertSafeKey = (key: string): string => {
    const full = resolve(baseDir, key);
    if (full !== baseDir && !full.startsWith(baseDir + sep)) {
      throw new Error(`Invalid blob key (path traversal): ${key}`);
    }
    return full;
  };
  const assertNoSymlinkComponents = async (full: string): Promise<void> => {
    const relativePath = relative(baseDir, full);
    let current = baseDir;
    for (const component of relativePath.split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Blob path contains a symlink: ${current}`);
        if (!stat.isDirectory() && current !== full) {
          throw new Error(`Blob path component is not a directory: ${current}`);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
        throw e;
      }
    }
  };
  const ensureSafeDirectory = async (directory: string): Promise<void> => {
    await assertBaseDirNotSymlink();
    try {
      await fs.lstat(baseDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      await fs.mkdir(baseDir, { recursive: true });
      await assertBaseDirNotSymlink();
    }
    const relativePath = relative(baseDir, directory);
    let current = baseDir;
    for (const component of relativePath.split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Blob path contains a symlink: ${current}`);
        if (!stat.isDirectory()) throw new Error(`Blob path component is not a directory: ${current}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
        await fs.mkdir(current, { recursive: true });
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Blob path component is not a directory: ${current}`);
        }
      }
    }
  };
  const assertSized = (actual: number, key: string): void => {
    if (actual > boundedMaxBytes) {
      throw new PayloadTooLargeError(`Blob ${key} is ${actual} bytes (> ${boundedMaxBytes})`, actual, boundedMaxBytes);
    }
  };
  const openReadable = async (key: string) => {
    const full = assertSafeKey(key);
    await assertNoSymlinkComponents(full);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      const size = (await handle.stat()).size;
      // Fail closed on empty/stale reads: an empty file is never a valid blob.
      if (size === 0) throw new NotFoundError(`Blob ${key} is empty`);
      assertSized(size, key);
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof NotFoundError || (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') {
        throw error instanceof NotFoundError ? error : new NotFoundError(`Blob ${key} not found`);
      }
      throw error;
    }
  };
  return {
    async put(key, body, _contentType) {
      void _contentType;
      await assertBaseDirNotSymlink();
      assertSized(body.byteLength, key);
      const path = assertSafeKey(key);
      await ensureSafeDirectory(dirname(path));
      await assertNoSymlinkComponents(path);
      const handle = await fs.open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
    },
    async get(key) {
      await assertBaseDirNotSymlink();
      const handle = await openReadable(key);
      try {
        const body = await handle.readFile();
        assertSized(body.byteLength, key);
        return body;
      } finally {
        await handle.close();
      }
    },
    async stream(key) {
      await assertBaseDirNotSymlink();
      const handle = await openReadable(key);
      const nodeStream = handle.createReadStream({ start: 0, end: boundedMaxBytes - 1, autoClose: true });
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      try {
        const path = assertSafeKey(key);
        await assertNoSymlinkComponents(path);
        await fs.unlink(path);
      } catch (e) {
        logger.warn(`[blob-storage] delete failed for ${key}`, { error: e });
      }
    },
  };
}

registerBlobStorageProvider('filesystem', createFilesystemBlobStorage);
