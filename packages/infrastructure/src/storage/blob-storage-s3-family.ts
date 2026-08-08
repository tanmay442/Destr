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
export function createS3FamilyBlobStorage(config: S3FamilyConfig): BlobStorage {
  const maxBytes = config.maxBytes ?? BLOB_GET_MAX_BYTES;
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
      const resp = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return Buffer.from(await resp.Body!.transformToByteArray());
    },
    async stream(key) {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      assertReadable(head.ContentLength, key);
      const resp = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return resp.Body!.transformToWebStream() as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
    async signedUrl(key, ttlSec) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: ttlSec,
      });
    },
  };
}
