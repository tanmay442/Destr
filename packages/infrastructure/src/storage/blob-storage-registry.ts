import type { BlobStorage } from '@app/domain';
import { createProviderRegistry } from '../registry';

export type BlobStorageProvider = () => BlobStorage;

export const blobStorageRegistry = createProviderRegistry<BlobStorageProvider>();

export function registerBlobStorageProvider(key: string, factory: BlobStorageProvider): void {
  blobStorageRegistry.register(key, factory);
}
