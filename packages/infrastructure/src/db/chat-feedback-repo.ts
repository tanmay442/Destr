import { sql, type SQL } from 'drizzle-orm';
import { db } from './client';
import { chatEvents, chatFeedback, chatTurns } from './schema';
import type {
  ChatFeedbackRepo,
  ChatEventRange,
  FeedbackUpsertResult,
  FeedbackSummary,
  DocumentSentiment,
  ThumbsDownDoc,
} from '@app/domain';

type Client = typeof db;

function intArray(values: number[]): SQL {
  const items = values.map((n) => sql`${Math.trunc(n)}`);
  return sql`array[${sql.join(items, sql`, `)}]::int[]`;
}

function rangeConds(column: SQL, range?: ChatEventRange): SQL {
  const parts: SQL[] = [];
  if (range?.from) parts.push(sql`${column} >= ${range.from}`);
  if (range?.to) parts.push(sql`${column} <= ${range.to}`);
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``;
}

export class ChatFeedbackRepository implements ChatFeedbackRepo {
  constructor(private readonly client: Client = db) {}

  async upsertFeedback(input: {
    turnId: string;
    userId: string;
    feedback: 1 | -1;
    documentIds: number[];
    chunkIds: number[];
  }): Promise<FeedbackUpsertResult> {
    const result = await this.client.execute(sql`
      with target as (
        select ${chatEvents.turnId} as turn_id, ${chatEvents.userId} as user_id
        from ${chatEvents}
        where ${chatEvents.turnId} = ${input.turnId}
          and ${chatEvents.createdAt} = (
            select ${chatTurns.createdAt}
            from ${chatTurns}
            where ${chatTurns.turnId} = ${input.turnId}
          )
      ),
      upserted as (
        insert into ${chatFeedback} (turn_id, feedback, document_ids, chunk_ids)
        select turn_id, ${input.feedback}, ${intArray(input.documentIds)}, ${intArray(input.chunkIds)}
        from target
        where target.user_id is null or target.user_id = ${input.userId}
        on conflict (turn_id) do update set
          feedback = excluded.feedback,
          document_ids = excluded.document_ids,
          chunk_ids = excluded.chunk_ids,
          created_at = now()
        returning turn_id
      )
      select
        (select count(*) from target)::int as found,
        (select count(*) from upserted)::int as upserted
    `);
    const row = (result as unknown as { rows: Array<{ found: number; upserted: number }> }).rows?.[0];
    if (!row || Number(row.found) === 0) return 'not_found';
    if (Number(row.upserted) === 0) return 'forbidden';
    return 'ok';
  }

  async getFeedbackSummary(range?: ChatEventRange): Promise<FeedbackSummary> {
    const feedbackResult = await this.client.execute(sql`
      select
        count(*) filter (where feedback = 1)::int as up,
        count(*) filter (where feedback = -1)::int as down,
        count(*)::int as total
      from ${chatFeedback}
      where true${rangeConds(sql`created_at`, range)}
    `);
    const eventsResult = await this.client.execute(sql`
      select count(*)::int as total_events
      from ${chatEvents}
      where true${rangeConds(sql`created_at`, range)}
    `);
    const f = (feedbackResult as unknown as { rows: Array<{ up: number; down: number; total: number }> }).rows?.[0];
    const e = (eventsResult as unknown as { rows: Array<{ total_events: number }> }).rows?.[0];
    return {
      up: Number(f?.up ?? 0),
      down: Number(f?.down ?? 0),
      total: Number(f?.total ?? 0),
      totalEvents: Number(e?.total_events ?? 0),
    };
  }

  async getDocumentSentiment(limit: number, range?: ChatEventRange): Promise<DocumentSentiment[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const result = await this.client.execute(sql`
      select
        d.id as document_id,
        d.file_name as file_name,
        count(*) filter (where f.feedback = 1)::int as up,
        count(*) filter (where f.feedback = -1)::int as down
      from ${chatFeedback} f
      cross join lateral unnest(f.document_ids) as ref(document_id)
      join documents d on d.id = ref.document_id and d.deleted_at is null
      where true${rangeConds(sql`f.created_at`, range)}
      group by d.id, d.file_name
      order by (count(*))::int desc
      limit ${capped}
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return rows.map((r) => ({
      documentId: Number(r.document_id),
      fileName: r.file_name === null ? null : String(r.file_name),
      up: Number(r.up),
      down: Number(r.down),
    }));
  }

  async getThumbsDownDocs(limit: number, range?: ChatEventRange): Promise<ThumbsDownDoc[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const result = await this.client.execute(sql`
      select
        d.id as document_id,
        d.file_name as file_name,
        count(*)::int as down
      from ${chatFeedback} f
      cross join lateral unnest(f.document_ids) as ref(document_id)
      join documents d on d.id = ref.document_id and d.deleted_at is null
      where f.feedback = -1${rangeConds(sql`f.created_at`, range)}
      group by d.id, d.file_name
      order by down desc
      limit ${capped}
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return rows.map((r) => ({
      documentId: Number(r.document_id),
      fileName: r.file_name === null ? null : String(r.file_name),
      down: Number(r.down),
    }));
  }
}

export function createChatFeedbackRepo(client: Client = db): ChatFeedbackRepo {
  return new ChatFeedbackRepository(client);
}
