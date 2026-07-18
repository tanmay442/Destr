import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BLOB_GET_MAX_BYTES, PayloadTooLargeError, type BlobStorage } from '@app/domain';

export function createR2BlobStorage(): BlobStorage {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET must be set.');
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async get(key) {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const size = head.ContentLength ?? 0;
      if (size > BLOB_GET_MAX_BYTES) {
        throw new PayloadTooLargeError(`Blob ${key} is ${size} bytes (> ${BLOB_GET_MAX_BYTES})`, size, BLOB_GET_MAX_BYTES);
      }
      const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await resp.Body!.transformToByteArray());
    },
    async stream(key) {
      const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return resp.Body!.transformToWebStream() as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async signedUrl(key, ttlSec) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttlSec,
      });
    },
  };
}
