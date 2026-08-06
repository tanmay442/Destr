import { customType } from 'drizzle-orm/pg-core';

export const byteaBlob = customType<{ data: Buffer | null; driverData: Buffer | null }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Buffer | null): Buffer | null {
    return value;
  },
  fromDriver(value: unknown): Buffer | null {
    if (value == null) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      return Buffer.from(value as Uint8Array);
    }
    throw new Error(`Unexpected value type from driver: ${typeof value}`);
  },
});
