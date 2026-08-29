import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundError, PayloadTooLargeError } from '@app/domain';
import { createFilesystemBlobStorage } from './blob-storage-fs';
import { byteaBlob } from './bytea-blob';
import { pgTable } from 'drizzle-orm/pg-core';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: sendMock };
  }),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://presigned.example'),
}));

import { createS3FamilyBlobStorage } from './blob-storage-s3-family';
import { HeadObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

describe('filesystem blob storage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'blob-fs-'));
    process.env.BLOB_FS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.BLOB_FS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips put/get/stream', async () => {
    const store = createFilesystemBlobStorage();
    await store.put('docs/a.pdf', Buffer.from('hello world'), 'application/pdf');
    await expect(store.get('docs/a.pdf')).resolves.toEqual(Buffer.from('hello world'));
    const stream = await store.stream('docs/a.pdf');
    const reader = stream.getReader();
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(...value);
    }
    expect(Buffer.from(chunks).toString()).toBe('hello world');
  });

  it('ignores contentType on put', async () => {
    const store = createFilesystemBlobStorage();
    await expect(store.put('a', Buffer.from('x'), 'application/pdf')).resolves.toBeUndefined();
    await expect(store.put('a', Buffer.from('y'), undefined as unknown as string)).resolves.toBeUndefined();
  });

  it('rejects put/get/stream above the size cap with PayloadTooLargeError', async () => {
    const big = Buffer.from('1234567890');
    const strict = createFilesystemBlobStorage(5);
    await expect(strict.put('big', big, 'application/pdf')).rejects.toBeInstanceOf(PayloadTooLargeError);
    const lenient = createFilesystemBlobStorage(100);
    await lenient.put('big', big, 'application/pdf');
    await expect(strict.get('big')).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(strict.stream('big')).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('rejects path traversal and absolute keys', async () => {
    const store = createFilesystemBlobStorage();
    await expect(store.put('../escape.txt', Buffer.from('x'), 'application/octet-stream')).rejects.toThrow(/path traversal/);
    await expect(store.put(join(dir, '..', 'escape.txt'), Buffer.from('x'), 'application/octet-stream')).rejects.toThrow(/path traversal/);
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/path traversal/);
  });

  it('rejects symlinked path components', async () => {
    const store = createFilesystemBlobStorage();
    await fs.mkdir(join(dir, 'target'));
    await fs.symlink(join(dir, 'target'), join(dir, 'link'));
    await expect(store.put('link/escape.bin', Buffer.from('x'), 'application/octet-stream')).rejects.toThrow(/symlink/);
    await expect(store.get('link/escape.bin')).rejects.toThrow(/symlink/);
  });

  it('logs delete failures instead of swallowing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFilesystemBlobStorage();
    await store.delete('does-not-exist');
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('delete failed');
    expect(line).toContain('does-not-exist');
    warn.mockRestore();
  });

  it('fails closed on key-not-found for get and stream', async () => {
    const store = createFilesystemBlobStorage();
    await expect(store.get('missing-key')).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.stream('missing-key')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('fails closed on empty/stale blobs for get and stream', async () => {
    const store = createFilesystemBlobStorage();
    await store.put('empty', Buffer.alloc(0), 'application/octet-stream');
    await expect(store.get('empty')).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.stream('empty')).rejects.toBeInstanceOf(NotFoundError);
    expect(await fs.readFile(join(dir, 'empty'))).toHaveLength(0);
  });
});

describe('blob storage factory fail-closed (M3)', () => {
  const originalEnv = process.env;
  let dir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_ENV;
    delete process.env.BLOB_FS_DIR;
    dir = await fs.mkdtemp(join(tmpdir(), 'blob-factory-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('defaults to filesystem outside production', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    delete process.env.BLOB_STORAGE_PROVIDER;
    const { createBlobStorage } = await import('./blob-storage-factory');
    const store = createBlobStorage();
    expect(typeof store.put).toBe('function');
    expect(typeof store.get).toBe('function');
  });

  it('throws in production when no explicit provider is set', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.BLOB_STORAGE_PROVIDER;
    const { createBlobStorage } = await import('./blob-storage-factory');
    expect(() => createBlobStorage()).toThrow(/BLOB_STORAGE_PROVIDER is not set/);
  });

  it('treats VERCEL_ENV=production the same as NODE_ENV=production', async () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.BLOB_STORAGE_PROVIDER;
    const { createBlobStorage } = await import('./blob-storage-factory');
    expect(() => createBlobStorage()).toThrow(/BLOB_STORAGE_PROVIDER is not set/);
  });

  it('refuses filesystem in production unless BLOB_FS_DIR is explicitly configured', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.BLOB_STORAGE_PROVIDER = 'filesystem';
    const { createBlobStorage } = await import('./blob-storage-factory');
    expect(() => createBlobStorage()).toThrow(/BLOB_FS_DIR/);
    process.env.BLOB_FS_DIR = dir;
    const store = createBlobStorage();
    expect(typeof store.put).toBe('function');
    await store.put('ok', Buffer.from('x'), 'application/octet-stream');
  });
});

describe('S3-family blob storage', () => {
  const creds = { accessKeyId: 'k', secretAccessKey: 's' };

  beforeEach(() => {
    sendMock.mockReset();
  });

  it('rejects put bodies above the cap before hitting the client', async () => {
    const store = createS3FamilyBlobStorage({ bucket: 'b', credentials: creds, maxBytes: 4 });
    await expect(store.put('k', Buffer.from('12345'), 'application/octet-stream')).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('puts within the cap and forwards contentType', async () => {
    sendMock.mockResolvedValue({});
    const store = createS3FamilyBlobStorage({ bucket: 'b', credentials: creds, maxBytes: 4 });
    await store.put('k', Buffer.from('123'), 'application/pdf');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [cmd] = sendMock.mock.calls[0] as [unknown];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
  });

  it('heads before get and stream, rejecting oversized blobs', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof HeadObjectCommand) return { ContentLength: 9 };
      return { Body: { transformToByteArray: async () => new Uint8Array([1]), transformToWebStream: () => new ReadableStream() } };
    });
    const store = createS3FamilyBlobStorage({ bucket: 'b', credentials: creds, maxBytes: 4 });
    await expect(store.get('k')).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(store.stream('k')).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('reads blobs within the cap', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof HeadObjectCommand) return { ContentLength: 3 };
      if (cmd instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      }
      return {};
    });
    const store = createS3FamilyBlobStorage({ bucket: 'b', credentials: creds, maxBytes: 4 });
    await expect(store.get('k')).resolves.toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('bytea blob driver mapping', () => {
  const tbl = pgTable('bytea_test', { blob: byteaBlob('blob') });

  it('passes Buffers through unchanged', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(tbl.blob.mapToDriverValue(buf)).toBe(buf);
    expect(tbl.blob.mapFromDriverValue(buf)).toBe(buf);
  });

  it('converts Uint8Array and ArrayBuffer values from the driver', () => {
    expect(tbl.blob.mapFromDriverValue(new Uint8Array([1, 2, 3]))).toEqual(Buffer.from([1, 2, 3]));
    expect(tbl.blob.mapFromDriverValue(new Uint8Array([4, 5]).buffer)).toEqual(Buffer.from([4, 5]));
  });

  it('maps null and throws on unexpected driver values', () => {
    expect(tbl.blob.mapFromDriverValue(null)).toBeNull();
    expect(() => tbl.blob.mapFromDriverValue('not-bytes')).toThrow(/Unexpected value type/);
  });
});
