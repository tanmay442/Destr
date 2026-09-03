import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PayloadTooLargeError, type BlobStorage } from '@app/domain';
import { BLOB_GET_MAX_BYTES } from '@app/infrastructure/config';

export interface S3FamilyConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  maxBytes?: number;
}

/**
 * S3-compatible blob storage shared by the R2 and S3 providers. Both adapters
 * are byte-identical apart from endpoint/region/forcePathStyle, so a single
 * implementation prevents drift.
 */
function bodyToWebStream(body: unknown, maxBytes: number, key: string): ReadableStream<Uint8Array> {
  if (!body || typeof body !== 'object') throw new Error(`Blob ${key} response had no readable body`);
  const candidate = body as {
    transformToWebStream?: (() => ReadableStream<Uint8Array>) | undefined;
    transformToByteArray?: (() => Promise<Uint8Array>) | undefined;
  };
  if (typeof candidate.transformToWebStream === 'function') return candidate.transformToWebStream();
  if (typeof candidate.transformToByteArray === 'function') {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const bytes = await candidate.transformToByteArray!();
          if (bytes.byteLength > maxBytes) {
            controller.error(new PayloadTooLargeError(`Blob ${key} exceeds ${maxBytes} bytes`, bytes.byteLength, maxBytes));
            return;
          }
          controller.enqueue(bytes);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }
  throw new Error(`Blob ${key} response had no supported body reader`);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  key: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(`Blob ${key} exceeds ${maxBytes} bytes`, size, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.allocUnsafe(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function limitReadableStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  key: string,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        if (!value) return;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          controller.error(new PayloadTooLargeError(`Blob ${key} exceeds ${maxBytes} bytes`, size, maxBytes));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
    },
  });
}

export function createS3FamilyBlobStorage(config: S3FamilyConfig): BlobStorage {
  const requestedMaxBytes = config.maxBytes ?? BLOB_GET_MAX_BYTES;
  const maxBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
    ? Math.max(1, Math.floor(requestedMaxBytes))
    : BLOB_GET_MAX_BYTES;
  const client = new S3Client({
    region: config.region ?? 'auto',
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
    credentials: config.credentials,
  });
  const assertReadable = (size: number | undefined, key: string): void => {
    const actual = size ?? 0;
    if (actual > maxBytes) {
      throw new PayloadTooLargeError(`Blob ${key} is ${actual} bytes (> ${maxBytes})`, actual, maxBytes);
    }
  };
  return {
    async put(key, body, contentType) {
      if (body.byteLength > maxBytes) {
        throw new PayloadTooLargeError(`Blob ${key} is ${body.byteLength} bytes (> ${maxBytes})`, body.byteLength, maxBytes);
      }
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async get(key) {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      assertReadable(head.ContentLength, key);
      const resp = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }));
      if (resp.ContentLength !== undefined) assertReadable(resp.ContentLength, key);
      if (resp.ContentRange) {
        const total = Number(resp.ContentRange.split('/').pop());
        if (Number.isFinite(total)) assertReadable(total, key);
      }
      if (!resp.Body) throw new Error(`Blob ${key} response had no body`);
      const bytes = await readBoundedStream(bodyToWebStream(resp.Body, maxBytes, key), maxBytes, key);
      assertReadable(bytes.byteLength, key);
      return bytes;
    },
    async stream(key) {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      assertReadable(head.ContentLength, key);
      const resp = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }));
      if (resp.ContentLength !== undefined) assertReadable(resp.ContentLength, key);
      if (resp.ContentRange) {
        const total = Number(resp.ContentRange.split('/').pop());
        if (Number.isFinite(total)) assertReadable(total, key);
      }
      if (!resp.Body) throw new Error(`Blob ${key} response had no body`);
      return limitReadableStream(bodyToWebStream(resp.Body, maxBytes, key), maxBytes, key);
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
    async signedUrl(key, ttlSec) {
      const requestedTtl = Number.isFinite(ttlSec) ? Math.floor(ttlSec) : 300;
      const expiresIn = Math.min(Math.max(requestedTtl, 1), 7 * 24 * 60 * 60);
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn,
      });
    },
  };
}
