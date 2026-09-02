import {
  pgTable, serial, bigserial, text, timestamp, integer, real, jsonb, boolean,
  index, check, foreignKey, uniqueIndex, uuid, smallint,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vector, tsvector } from './schema-vector';
import { byteaBlob } from '../storage/bytea-blob';
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  MAX_STORED_MESSAGE_BYTES,
  type IngestStatus,
  type AppConfig,
} from '@app/domain';

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  documentUid: uuid('document_uid').defaultRandom().notNull(),
  fileName: text('file_name').notNull(),
  fileHash: text('file_hash').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  blob: byteaBlob('blob'),
  storageKey: text('storage_key'),
  ingestStatus: text('ingest_status').notNull().default('done').$type<IngestStatus>(),
  ingestUpdatedAt: timestamp('ingest_updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('documents_file_name_unique')
    .on(table.fileName)
    .where(sql`${table.deletedAt} IS NULL`),
  uniqueIndex('documents_document_uid_unique').on(table.documentUid),
  index('documents_deleted_at_idx').on(table.deletedAt),
  index('documents_ingest_status_updated_idx')
    .on(table.ingestStatus, table.ingestUpdatedAt)
    .where(sql`${table.deletedAt} IS NULL`),
  index('documents_uploaded_at_id_idx')
    .on(table.uploadedAt.desc(), table.id.desc()),
]);

export const chunks = pgTable('chunks', {
  id: serial('id').primaryKey(),
  chunkUid: text('chunk_uid').notNull(),
  documentId: integer('document_id').references(() => documents.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding').notNull(),
  chunkIndex: integer('chunk_index').notNull().default(0),
  page: integer('page'),
  sectionTitle: text('section_title'),
  source: text('source'),
  title: text('title'),
  parentChunkId: integer('parent_chunk_id'),
  kind: text('kind').notNull().default('child'),
  embeddingModel: text('embedding_model'),
  contentHash: text('content_hash').notNull(),
  tsv: tsvector('tsv').generatedAlwaysAs(() => sql`to_tsvector('english', content)`),
}, (table) => [
  uniqueIndex('chunks_chunk_uid_unique').on(table.chunkUid),
  index('embedding_idx')
    .using('hnsw', sql`${table.embedding} vector_cosine_ops`)
    .where(sql`${table.kind} <> 'parent'`),
  index('chunks_document_id_idx').on(table.documentId),
  index('chunks_document_id_chunk_index_idx').on(table.documentId, table.chunkIndex),
  index('chunks_tsv_idx').using('gin', sql`${table.tsv}`),
  check('chunks_kind_check', sql`${table.kind} IN ('parent','child','summary')`),
  foreignKey({
    columns: [table.parentChunkId],
    foreignColumns: [table.id],
    name: 'chunks_parent_chunk_id_fk',
  }),
]);

export const tickets = pgTable('tickets', {
  // This table can outlive the 32-bit serial range at deployment scale.
  // Keep the JS representation numeric, with safe-integer validation at
  // repository boundaries (see safe-id.ts); never emit a raw bigint in JSON.
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ticketId: text('ticket_id').notNull().unique(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  issue: text('issue').notNull(),
  status: text('status').notNull().default('created'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  assignedTo: text('assigned_to'),
  notes: text('notes'),
}, (table) => [
  index('tickets_status_idx').on(table.status),
  check('tickets_status_check', sql`${table.status} IN ('created','in_progress','closed')`),
  index('tickets_assigned_to_idx').on(table.assignedTo),
  index('tickets_created_at_id_idx').on(table.createdAt.desc(), table.id.desc()),
]);

export const users = pgTable('users', {
  clerkUserId: text('clerk_user_id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  imageUrl: text('image_url'),
  role: text('role').notNull().default('user'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('users_role_check', sql`${table.role} IN ('admin','user')`),
  index('users_created_at_id_idx').on(table.createdAt, table.clerkUserId),
]);

/** Generic audit trail. `source_ref` is retained for historical backfill data. */
export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'number' }).notNull(),
  kind: text('kind').notNull(),
  action: text('action').notNull(),
  actorId: text('actor_id').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  details: jsonb('details').notNull().default({}),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  sourceRef: text('source_ref'),
}, (table) => [
  check('audit_events_kind_check', sql`${table.kind} IN ('document','ticket','user','settings','chat')`),
  index('audit_events_kind_idx').on(table.kind),
  index('audit_events_at_id_idx').on(table.at.desc(), table.id.desc()),
  index('audit_events_actor_id_idx').on(table.actorId),
  index('audit_events_kind_target_id_idx').on(table.kind, table.targetId),
  primaryKey({ columns: [table.id, table.at], name: 'audit_events_pkey' }),
]);

/**
 * Dead-letter store for audit events whose primary write failed. Keeps the
 * main operation available (we never block on audit) while preserving a
 * durable, queryable record of the gap for compliance replay.
 */
export const auditDeadLetter = pgTable('audit_dead_letter', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  error: text('error').notNull(),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).defaultNow().notNull(),
  replayed: boolean('replayed').notNull().default(false),
}, (table) => [
  index('audit_dead_letter_attempted_at_idx').on(table.attemptedAt.desc()),
  index('audit_dead_letter_replayed_idx').on(table.replayed).where(sql`${table.replayed} = false`),
]);

/** Append-only per-turn chat metrics. `mode` is `agentic` or `vector`. */
/**
 * Non-partitioned registry for globally unique turn IDs. The physical event
 * table is range-partitioned by created_at, so a parent-level UNIQUE(turn_id)
 * cannot be represented by PostgreSQL. Migration 0029 installs triggers that
 * register a turn and reject duplicate events atomically.
 */
export const chatTurns = pgTable('chat_turns', {
  turnId: uuid('turn_id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  userId: text('user_id'),
}, (table) => [
  index('chat_turns_created_at_idx').on(table.createdAt),
  index('chat_turns_user_id_idx').on(table.userId),
]);

export const chatEvents = pgTable('chat_events', {
  id: bigserial('id', { mode: 'number' }).notNull(),
  turnId: uuid('turn_id').references(() => chatTurns.turnId, { onDelete: 'restrict' }),
  userId: text('user_id'),
  query: text('query'),
  mode: text('mode').notNull(),
  retrieveMs: integer('retrieve_ms'),
  generateMs: integer('generate_ms'),
  totalMs: integer('total_ms'),
  hitCount: integer('hit_count'),
  maxSimilarity: real('max_similarity'),
  outOfDomain: boolean('out_of_domain').notNull().default(false),
  hallucinationBlocked: boolean('hallucination_blocked').notNull().default(false),
  cacheHit: boolean('cache_hit').notNull().default(false),
  ticketCreated: boolean('ticket_created').notNull().default(false),
  citationCount: integer('citation_count'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  meta: jsonb('meta').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.id, table.createdAt], name: 'chat_events_pkey' }),
  check('chat_events_mode_check', sql`${table.mode} IN ('agentic','vector')`),
  index('chat_events_created_at_idx').on(table.createdAt.desc()),
  index('chat_events_mode_idx').on(table.mode),
  index('chat_events_user_id_idx').on(table.userId),
  index('idx_chat_events_meta_document_ids').using('gin', sql`((${table.meta} -> 'documentIds'))`),
]);

export const chatFeedback = pgTable('chat_feedback', {
  turnId: uuid('turn_id').primaryKey().references(() => chatTurns.turnId, { onDelete: 'cascade' }),
  feedback: smallint('feedback').notNull(),
  documentIds: integer('document_ids').array().notNull().default(sql`'{}'`),
  chunkIds: integer('chunk_ids').array().notNull().default(sql`'{}'`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('chat_feedback_value_check', sql`${table.feedback} IN (1, -1)`),
  index('chat_feedback_created_at_idx').on(table.createdAt),
]);

export const qualityReviews = pgTable('quality_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  turnId: uuid('turn_id').references(() => chatTurns.turnId, { onDelete: 'cascade' }),
  reviewerId: text('reviewer_id').references(() => users.clerkUserId, { onDelete: 'cascade' }),
  verdict: text('verdict').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('quality_reviews_verdict_check', sql`${table.verdict} IN ('good','bad','docs_missing')`),
  index('quality_reviews_turn_id_idx').on(table.turnId),
  index('quality_reviews_reviewer_id_idx').on(table.reviewerId),
  index('quality_reviews_created_at_idx').on(table.createdAt),
  uniqueIndex('quality_reviews_turn_reviewer_unique').on(table.turnId, table.reviewerId),
]);

export const chatConversations = pgTable('chat_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.clerkUserId, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  messageCount: integer('message_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('chat_conversations_title_len_check', sql`char_length(${table.title}) <= ${sql.raw(String(MAX_CONVERSATION_TITLE_LENGTH))}`),
  index('idx_chat_conversations_user_updated').on(table.userId, table.updatedAt.desc()),
  index('chat_conversations_updated_at_idx').on(table.updatedAt),
]);

export const chatMessages = pgTable('chat_messages', {
  id: bigserial('id', { mode: 'number' }).notNull(),
  conversationId: uuid('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),
  turnId: uuid('turn_id'),
  role: text('role').notNull(),
  content: jsonb('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.id], name: 'chat_messages_pkey' }),
  check('chat_messages_role_check', sql`${table.role} IN ('user','assistant')`),
  check('chat_messages_content_bytes_check', sql`octet_length(${table.content}::text) <= ${sql.raw(String(MAX_STORED_MESSAGE_BYTES))}`),
  index('idx_chat_messages_conversation_id').on(table.conversationId, table.id),
  uniqueIndex('chat_messages_turn_unique').on(table.conversationId, table.turnId, table.role),
]);

export type ChatConversation = typeof chatConversations.$inferSelect;
export type NewChatConversation = typeof chatConversations.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

export type ChatEvent = typeof chatEvents.$inferSelect;
export type NewChatEvent = typeof chatEvents.$inferInsert;
export type ChatFeedback = typeof chatFeedback.$inferSelect;
export type NewChatFeedback = typeof chatFeedback.$inferInsert;
export type QualityReview = typeof qualityReviews.$inferSelect;
export type NewQualityReview = typeof qualityReviews.$inferInsert;

export type Document = typeof documents.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type User = typeof users.$inferSelect;

export const appSettings = pgTable('app_settings', {
  id: integer('id').primaryKey(),
  overrides: jsonb('overrides').notNull().$type<Partial<AppConfig>>().default({}),
  version: integer('version').notNull().default(0),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
