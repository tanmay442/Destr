// `blob` bytea retained until backfill moves binaries to `storage_key`.
import {
  pgTable, serial, text, timestamp, integer, jsonb, boolean,
  index, check, foreignKey, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vector, tsvector } from './schema-vector';
import { byteaBlob } from '../storage/bytea-blob';
import type { IngestStatus, AppConfig } from '@app/domain';

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  fileName: text('file_name').notNull(),
  fileHash: text('file_hash').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
  blob: byteaBlob('blob'),
  storageKey: text('storage_key'),
  ingestStatus: text('ingest_status').notNull().default('done').$type<IngestStatus>(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  uniqueIndex('documents_file_name_unique')
    .on(table.fileName)
    .where(sql`${table.deletedAt} IS NULL`),
  index('documents_deleted_at_idx').on(table.deletedAt),
  index('documents_uploaded_at_idx').on(table.uploadedAt.desc()),
]);

export const chunks = pgTable('chunks', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id').references(() => documents.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding').notNull(),
  // --- Metadata + provenance (Session 1, additive) ---
  chunkIndex: integer('chunk_index').notNull().default(0),
  page: integer('page'),
  sectionTitle: text('section_title'),
  source: text('source'),
  parentChunkId: integer('parent_chunk_id'),
  kind: text('kind').notNull().default('child'),
  embeddingModel: text('embedding_model'),
  contentHash: text('content_hash'),
  // Full-text-search vector: STORED generated from `content`, used by Session 7 hybrid retrieval.
  tsv: tsvector('tsv').generatedAlwaysAs(() => sql`to_tsvector('english', content)`),
}, (table) => [
  // Partial HNSW index: parent blocks carry a constant placeholder vector
  // (Session 5, Option C) and are filtered out of every vector query, so they
  // never need to live in the ANN index. Excluding them keeps the index small.
  index('embedding_idx')
    .using('hnsw', sql`${table.embedding} vector_cosine_ops`)
    .where(sql`${table.kind} <> 'parent'`),
  index('chunks_document_id_idx').on(table.documentId),
  index('chunks_tsv_idx').using('gin', sql`${table.tsv}`),
  foreignKey({
    columns: [table.parentChunkId],
    foreignColumns: [table.id],
    name: 'chunks_parent_chunk_id_fk',
  }),
]);

export const tickets = pgTable('tickets', {
  id: serial('id').primaryKey(),
  ticketId: text('ticket_id').notNull().unique(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  issue: text('issue').notNull(),
  status: text('status').notNull().default('created'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  assignedTo: text('assigned_to'),
  notes: text('notes'),
}, (table) => [
  index('tickets_status_idx').on(table.status),
  check('tickets_status_check', sql`${table.status} IN ('created','in_progress','closed')`),
]);

export const users = pgTable('users', {
  clerkUserId: text('clerk_user_id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  imageUrl: text('image_url'),
  role: text('role').notNull().default('user'),
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('users_role_check', sql`${table.role} IN ('admin','user')`),
]);

/**
 * Single generic audit trail (Session 5). Replaces the former per-category
 * `document_audit` / `ticket_audit` / `user_audit` tables. `source_ref` is a
 * backfill-only dedup key (`<old_table>:<old_id>`) that makes the backfill
 * migration idempotently re-runnable.
 */
export const auditEvents = pgTable('audit_events', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(),
  action: text('action').notNull(),
  actorId: text('actor_id').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  details: jsonb('details').notNull().default({}),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  sourceRef: text('source_ref'),
}, (table) => [
  check('audit_events_kind_check', sql`${table.kind} IN ('document','ticket','user','settings')`),
  index('audit_events_kind_idx').on(table.kind),
  index('audit_events_at_idx').on(table.at.desc()),
  index('audit_events_actor_id_idx').on(table.actorId),
  uniqueIndex('idx_audit_events_source_ref')
    .on(table.sourceRef)
    .where(sql`${table.sourceRef} IS NOT NULL`),
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
  attemptedAt: timestamp('attempted_at').defaultNow().notNull(),
  replayed: boolean('replayed').notNull().default(false),
});

export type Document = typeof documents.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type User = typeof users.$inferSelect;

export const appSettings = pgTable('app_settings', {
  id: integer('id').primaryKey(),
  overrides: jsonb('overrides').notNull().$type<Partial<AppConfig>>().default({}),
  version: integer('version').notNull().default(0),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at').defaultNow(),
});
