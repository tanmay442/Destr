import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createS3FamilyBlobStorage } from '../../blob-storage-s3-family';
import { runBlobStorageContract } from './blob-storage-contract';

const sendMock = vi.hoisted(() => vi.fn());

const s3 = vi.hoisted(() => {
  class PutObjectCommand {
    readonly kind = 'put' as const;
    input: { Key: string; Body: unknown; ContentType?: string };
    constructor(input: { Key: string; Body: unknown; ContentType?: string }) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    readonly kind = 'get' as const;
    input: { Key: string };
    constructor(input: { Key: string }) {
      this.input = input;
    }
  }
  class DeleteObjectCommand {
    readonly kind = 'delete' as const;
    input: { Key: string };
    constructor(input: { Key: string }) {
      this.input = input;
    }
  }
  class HeadObjectCommand {
    readonly kind = 'head' as const;
    input: { Key: string };
    constructor(input: { Key: string }) {
      this.input = input;
    }
  }
  return { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: sendMock };
  }),
  PutObjectCommand: s3.PutObjectCommand,
  GetObjectCommand: s3.GetObjectCommand,
  DeleteObjectCommand: s3.DeleteObjectCommand,
  HeadObjectCommand: s3.HeadObjectCommand,
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://presigned.example/key'),
}));

type PutCommand = InstanceType<typeof s3.PutObjectCommand>;
type GetCommand = InstanceType<typeof s3.GetObjectCommand>;
type DeleteCommand = InstanceType<typeof s3.DeleteObjectCommand>;
type HeadCommand = InstanceType<typeof s3.HeadObjectCommand>;
type Command = PutCommand | GetCommand | DeleteCommand | HeadCommand;

describe('S3-family blob storage contract', () => {
  const store = new Map<string, { body: Buffer; contentType?: string | undefined }>();

  beforeEach(() => {
    store.clear();
    sendMock.mockReset();
    sendMock.mockImplementation((cmd: Command) => {
      switch (cmd.kind) {
        case 'put': {
          store.set(cmd.input.Key, {
            body: Buffer.from(cmd.input.Body as Uint8Array),
            contentType: cmd.input.ContentType,
          });
          return Promise.resolve({});
        }
        case 'head': {
          const entry = store.get(cmd.input.Key);
          return Promise.resolve({ ContentLength: entry?.body.byteLength ?? 0 });
        }
        case 'get': {
          const entry = store.get(cmd.input.Key);
          const body = entry?.body ?? Buffer.alloc(0);
          return Promise.resolve({
            Body: {
              transformToByteArray: async () => new Uint8Array(body),
              transformToWebStream: () =>
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array(body));
                    controller.close();
                  },
                }),
            },
          });
        }
        case 'delete': {
          store.delete(cmd.input.Key);
          return Promise.resolve({});
        }
      }
    });
  });

  afterEach(() => {
    sendMock.mockReset();
  });

  runBlobStorageContract(
    (opts) =>
      createS3FamilyBlobStorage({
        bucket: 'test-bucket',
        region: 'auto',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
        ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      }),
    { supportsSignedUrl: true },
  );

  it('forwards content-type to the S3 client on put', async () => {
    const storage = createS3FamilyBlobStorage({
      bucket: 'test-bucket',
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    });
    await storage.put('k', Buffer.from('data'), 'application/pdf');
    const put = sendMock.mock.calls.find(([c]) => c instanceof s3.PutObjectCommand)?.[0] as
      | PutCommand
      | undefined;
    expect(put?.input.ContentType).toBe('application/pdf');
  });
});
