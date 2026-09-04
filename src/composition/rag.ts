import {
  ingestFile, searchChunks,
  listDocuments, uploadPdf,
  softDeleteDocument, restoreDocument,
  getDocumentById, hardDeleteDocument, replacePdf,
  recountChunksForDocument, recountChunksForAllDocuments,
  prepareIngest,
  replaceDocumentChunks,
  uploadPrechunkedMarkdown,
  reingestAll,
  agenticSearch,
} from '@app/application';
import { Llm, Queue, Markdown } from '@app/infrastructure';
import {
  RRF_K, LEXICAL_WEIGHT, RERANK_TOP_N, CANDIDATE_POOL,
  CCH_ENABLED,
} from '@app/infrastructure/config';
import type { AppConfig } from '@app/domain/app-config';
import { err, ok, NotFoundError, ExternalServiceError, type Result, type AgenticResultState } from '@app/domain';
import {
  core,
  documentRepo, chunkRepo, embeddingService, blobStorage, cursorCodec, clock, hasher, runner,
  bind, asyncIngest, ingestQueue, reingestQueue,
  resolveIngestDeps, getSearchDeps, getAgenticDeps, resolveReranker, availableRerankers,
} from './infra';
import { logger } from '../lib/logger';

class StaleIngestError extends Error {}

type QueuedIngestStatus = 'done' | 'already-done' | 'busy' | 'stale';

export async function ingestQueuedDocumentStandalone(
  documentId: number,
  queuedFileHash?: string,
  signal?: AbortSignal | undefined,
): Promise<Result<{ status: QueuedIngestStatus; chunks: number }>> {
  const doc = await documentRepo.findById(documentId);
  if (!doc) return err(new NotFoundError(`Document not found: ${documentId}`));
  if (queuedFileHash !== undefined && doc.fileHash !== queuedFileHash) {
    return ok({ status: 'stale', chunks: 0 });
  }
  const expectedFileHash = doc.fileHash;
  if (doc.ingestStatus === 'done') return ok({ status: 'already-done', chunks: 0 });
  if (doc.ingestStatus === 'ingesting') return ok({ status: 'busy', chunks: 0 });
  if (!doc.storageKey) return err(new NotFoundError(`Document ${documentId} has no stored blob`));

  const claimed = await documentRepo.claimIngest(documentId, expectedFileHash);
  if (!claimed) {
    const current = await documentRepo.findById(documentId);
    if (!current || current.fileHash !== expectedFileHash) return ok({ status: 'stale', chunks: 0 });
    if (current.ingestStatus === 'done') return ok({ status: 'already-done', chunks: 0 });
    return ok({ status: 'busy', chunks: 0 });
  }

  const updateStatusIfCurrent = async (
    expectedStatus: 'queued' | 'ingesting',
    nextStatus: 'queued' | 'failed',
  ): Promise<void> => {
    if (documentRepo.updateIngestStatusIfCurrent) {
      await documentRepo.updateIngestStatusIfCurrent(
        documentId,
        expectedFileHash,
        expectedStatus,
        nextStatus,
      );
      return;
    }
    await documentRepo.updateIngestStatus(documentId, nextStatus);
  };
  const requeue = () => updateStatusIfCurrent('ingesting', 'queued').catch(() => {});

  let buffer: Uint8Array;
  try {
    buffer = await blobStorage.get(doc.storageKey);
  } catch (error) {
    await requeue();
    return err(new ExternalServiceError('Blob read failed', error));
  }

  const blobHash = hasher.sha256(buffer);
  const current = await documentRepo.findById(documentId);
  if (
    !current ||
    current.fileHash !== expectedFileHash ||
    current.storageKey !== doc.storageKey ||
    current.ingestStatus !== 'ingesting'
  ) {
    await requeue();
    return ok({ status: 'stale', chunks: 0 });
  }
  if (blobHash !== expectedFileHash) {
    await updateStatusIfCurrent('ingesting', 'failed');
    return err(new ExternalServiceError('Stored blob does not match the document hash'));
  }

  let prepared: Awaited<ReturnType<typeof prepareIngest>>;
  try {
    prepared = await prepareIngest(
      { documentId, fileName: doc.fileName, buffer, signal },
      await resolveIngestDeps(),
    );
  } catch (error) {
    await requeue();
    return err(new ExternalServiceError('Ingest preparation failed', error));
  }
  if (!prepared.ok) {
    await requeue();
    return prepared;
  }

  try {
    await runner.run(async (tx) => {
      const fresh = await tx.documents.findById(documentId);
      if (
        !fresh ||
        fresh.fileHash !== expectedFileHash ||
        fresh.storageKey !== doc.storageKey ||
        fresh.ingestStatus !== 'ingesting'
      ) throw new StaleIngestError();
      await replaceDocumentChunks(tx.chunks, documentId, prepared.value.rows);
      if (tx.documents.updateIngestStatusIfCurrent) {
        const completed = await tx.documents.updateIngestStatusIfCurrent(
          documentId,
          expectedFileHash,
          'ingesting',
          'done',
        );
        if (!completed) throw new StaleIngestError();
      } else {
        await tx.documents.updateIngestStatus(documentId, 'done');
      }
    });
  } catch (error) {
    await requeue();
    if (error instanceof StaleIngestError) return ok({ status: 'stale', chunks: 0 });
    return err(new ExternalServiceError('Chunk insert failed', error));
  }
  return ok({ status: 'done', chunks: prepared.value.chunks });
}

export function buildRagOps() {
  const auditDeps = { audit: core.auditRepo };
  const userDeps = { users: core.userRepo };
  const txRunner = runner;

  return {
    ingestFile: async (input: Parameters<typeof ingestFile>[0]) => bind(ingestFile, input, await resolveIngestDeps()),
    searchChunks: (cfg: AppConfig, q: string, o: Parameters<typeof searchChunks>[1]) =>
      bind(
        searchChunks,
        q,
        {
          ...o,
          threshold: cfg.similarityThreshold,
          hybridEnabled: cfg.hybridEnabled,
          mode: cfg.parentChildMode,
          parentChildWindow: cfg.parentChildWindow,
          rrfK: o.rrfK ?? RRF_K,
          lexicalWeight: o.lexicalWeight ?? LEXICAL_WEIGHT,
          rerankTopN: o.rerankTopN ?? RERANK_TOP_N,
          candidateLimit: o.candidateLimit ?? CANDIDATE_POOL,
        },
        getSearchDeps(cfg),
      ),
    agenticSearch: async (cfg: AppConfig, query: string, opts: { signal?: AbortSignal | undefined } = {}) => {
      if (process.env.AGENTIC_ENABLED === 'false') {
        const fallback = await bind(
          searchChunks,
          query,
          {
            threshold: cfg.similarityThreshold,
            hybridEnabled: cfg.hybridEnabled,
            mode: cfg.parentChildMode,
            parentChildWindow: cfg.parentChildWindow,
            rrfK: RRF_K,
            lexicalWeight: LEXICAL_WEIGHT,
            rerankTopN: RERANK_TOP_N,
            candidateLimit: CANDIDATE_POOL,
            signal: opts.signal,
          },
          getSearchDeps(cfg),
        );
        if (!fallback.ok) return fallback;
        const chunks = fallback.value;
        const isEmpty = chunks.length === 0;
        return ok({
          chunks,
          rewrittenQuery: query,
          outOfDomain: isEmpty,
          isEmpty,
          fallbackReason: null,
          resultState: (isEmpty ? 'empty' : 'ok') as AgenticResultState,
        });
      }
      try {
        return await agenticSearch(query, getAgenticDeps(cfg, opts.signal));
      } catch (e) {
        return err(new ExternalServiceError('Agentic retrieval unavailable', e));
      }
    },
    getHallucinationGrader: (cfg: AppConfig) => Llm.getAuxModels(undefined, cfg.auxModel, core.chatModelProvider, core.env).hallucinationGrader?.grade ?? null,
    getSearchDeps,
    getAgenticDeps,
    resolveReranker,
    availableRerankers,
    listDocuments: (input: Parameters<typeof listDocuments>[0]) =>
      bind(listDocuments, input, { documents: documentRepo, chunks: chunkRepo, ...userDeps, cursorCodec }),
    uploadPdf: async (input: Parameters<typeof uploadPdf>[0]) =>
      bind(uploadPdf, input, { ...(await resolveIngestDeps()), asyncIngest, ...auditDeps, runner: txRunner, blobStorage, ingestQueue, ...userDeps }),
    softDeleteDocument: (input: Parameters<typeof softDeleteDocument>[0]) =>
      bind(softDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner, ...userDeps }),
    restoreDocument: (id: number, actorId: string) =>
      bind(restoreDocument, id, actorId, { documents: documentRepo, ...auditDeps, clock, runner: txRunner, ...userDeps }),
    getDocumentById: (id: number, opts?: { includeDeleted?: boolean | undefined }) => getDocumentById(id, { documents: documentRepo }, opts),
    hardDeleteDocument: (input: { documentId: number; actorId: string }) =>
      bind(hardDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner, blobStorage, ...userDeps }),
    replacePdf: async (input: Parameters<typeof replacePdf>[0]) =>
      bind(replacePdf, input, { ...(await resolveIngestDeps()), asyncIngest, ...auditDeps, runner: txRunner, blobStorage, ingestQueue, ...userDeps }),
    uploadChunkedMarkdown: (input: {
      fileName: string;
      mdText: string;
      delimiter?: string | undefined;
      uploadedBy: string;
      pdfBuffer?: Buffer | undefined;
      pdfFileName?: string | undefined;
      signal?: AbortSignal | undefined;
    }) =>
      bind(uploadPrechunkedMarkdown, input, {
        documents: documentRepo,
        chunks: chunkRepo,
        embeddings: embeddingService,
        hasher,
        blobStorage,
        pdfValidator: core.pdfValidator,
        runner: txRunner,
        markdownParser: Markdown.markdownParser,
        summarizer: Llm.createDocSummarizer(core.chatModelProvider, core.env),
        cchEnabled: CCH_ENABLED,
      }),
    ingestQueuedDocument: (documentId: number, fileHash?: string, signal?: AbortSignal | undefined) =>
      ingestQueuedDocumentStandalone(documentId, fileHash, signal),
    recountChunksForDocument: (id: number) => bind(recountChunksForDocument, id, { chunks: chunkRepo }),
    recountChunksForAllDocuments: () => bind(recountChunksForAllDocuments, { chunks: chunkRepo }),
    reingestAll: () =>
      reingestAll({ documents: documentRepo, queue: reingestQueue, chunks: chunkRepo, cursorCodec }),
    sweepStaleQueued: () => {
      const failDocumentIfStale = documentRepo.failDocumentIfStale;
      return Queue.createQueuedSweeper({
        listStaleQueued: (olderThan) => documentRepo.listStaleQueued(olderThan),
        failDocumentIfStale: failDocumentIfStale
          ? (id, olderThan) => failDocumentIfStale(id, olderThan)
          : undefined,
        failDocument: (id) => documentRepo.failDocument(id),
      }).sweep();
    },
    ingestDeadLetter: async (input: { documentId: number; fileHash: string; payload: unknown; error: string }) => {
      try {
        await auditDeps.audit.recordDeadLetter({
          kind: 'ingest',
          payload: input.payload,
          error: input.error,
        });
      } catch (e) {
        logger.warn('[ingest-dlq] failed to persist dead-letter row', { documentId: input.documentId, error: e instanceof Error ? e.message : String(e) });
      }
      if (documentRepo.failDocumentIfCurrent) {
        await documentRepo.failDocumentIfCurrent(input.documentId, input.fileHash);
      } else {
        logger.error('[ingest-dlq] repository cannot apply hash-conditional failure', { documentId: input.documentId });
      }
    },
    countPendingIngest: () => documentRepo.countPendingIngest(),
  };
}
