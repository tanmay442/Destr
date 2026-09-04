import { db } from '../client';
import { resolveVectorDim } from '../schema-vector';
import { defaultHasher } from '../stable-identities';
import type { Hasher, TransactionContext, TransactionRunner } from '@app/domain';
import { createDocumentRepo } from './documents';
import { createChunkRepo } from './chunks';
import { createAuditRepo } from './audit';
import { createTicketRepo } from './tickets';
import { createUserRepo } from './users';
import type { Client } from './shared';

export function createRepositoryAdapters(
  client: Client = db,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
) {
  return {
    documents: createDocumentRepo(client),
    chunks: createChunkRepo(client, vectorDim, hasher),
    audit: createAuditRepo(client),
    tickets: createTicketRepo(client),
    users: createUserRepo(client),
  };
}

export const transactionRunner: TransactionRunner = {
  async run<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const ctx: TransactionContext = createRepositoryAdapters(tx, resolveVectorDim());
      return fn(ctx);
    });
  },
};
