import { describe, it, expect } from 'vitest';
import { PayloadTooLargeError, type BlobStorage } from '@app/domain';

export interface BlobStorageContractOptions {
  /** Whether this implementation exposes `signedUrl`. */
  supportsSignedUrl: boolean;
}

export interface MakeStorageOptions {
  maxBytes?: number;
}

/**
 * Shared contract assertions every BlobStorage implementation must satisfy.
 * `makeStorage` may be called with a `maxBytes` cap so the size-limit
 * assertion can construct a strict instance.
 */
export function runBlobStorageContract(
  makeStorage: (opts?: MakeStorageOptions) => BlobStorage,
  opts: BlobStorageContractOptions,
): void {
  describe('blob storage contract', () => {
    it('round-trips put/get', async () => {
      const storage = makeStorage();
      const body = Buffer.from('hello world');
      await storage.put('docs/a.pdf', body, 'application/pdf');
      expect(await storage.get('docs/a.pdf')).toEqual(body);
    });

    it('round-trips stream', async () => {
      const storage = makeStorage();
      const body = Buffer.from('streamed bytes');
      await storage.put('docs/b.txt', body, 'text/plain');
      const stream = await storage.stream('docs/b.txt');
      const reader = stream.getReader();
      const chunks: number[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(...value);
      }
      expect(Buffer.from(chunks)).toEqual(body);
    });

    it('delete is idempotent', async () => {
      const storage = makeStorage();
      await storage.put('docs/c.txt', Buffer.from('x'), 'text/plain');
      await storage.delete('docs/c.txt');
      await expect(storage.delete('docs/c.txt')).resolves.toBeUndefined();
    });

    it('enforces the size cap on put', async () => {
      const strict = makeStorage({ maxBytes: 8 });
      await expect(
        strict.put('big', Buffer.from('123456789'), 'application/octet-stream'),
      ).rejects.toBeInstanceOf(PayloadTooLargeError);
      await expect(strict.put('ok', Buffer.from('12345678'), 'application/octet-stream')).resolves.toBeUndefined();
    });

    if (opts.supportsSignedUrl) {
      it('signedUrl returns a URL string for the key', async () => {
        const storage = makeStorage();
        const url = await storage.signedUrl!('docs/a.pdf', 60);
        expect(typeof url).toBe('string');
        expect(url).toMatch(/^https?:\/\//);
      });
    }
  });
}
