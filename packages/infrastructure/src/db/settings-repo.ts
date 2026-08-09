import { eq, and, sql } from 'drizzle-orm';
import { db } from './client';
import { appSettings } from './schema';
import type { SettingsRepo, AppConfig } from '@app/domain';

type Client = typeof db;

const ROW_ID = 1;

export function createSettingsRepo(client: Client = db): SettingsRepo {
  return {
    async getOverrides() {
      const existing = await client.query.appSettings.findFirst({
        where: eq(appSettings.id, ROW_ID),
      });
      if (existing) {
        return {
          overrides: (existing.overrides ?? {}) as Partial<AppConfig>,
          version: existing.version,
        };
      }
      // Seed on first read in a single round-trip; the returning row is the result.
      const [seeded] = await client
        .insert(appSettings)
        .values({ id: ROW_ID, overrides: {}, version: 0 })
        .onConflictDoNothing()
        .returning({ overrides: appSettings.overrides, version: appSettings.version });
      if (seeded) {
        return {
          overrides: (seeded.overrides ?? {}) as Partial<AppConfig>,
          version: seeded.version,
        };
      }
      // Lost a concurrent seed race: read the winner's row.
      const row = await client.query.appSettings.findFirst({
        where: eq(appSettings.id, ROW_ID),
      });
      return {
        overrides: (row?.overrides ?? {}) as Partial<AppConfig>,
        version: row?.version ?? 0,
      };
    },

    async saveOverrides({ patch, actorId, expectedVersion }) {
      const [row] = await client
        .update(appSettings)
        .set({
          overrides: patch,
          version: sql`${appSettings.version} + 1`,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(and(eq(appSettings.id, ROW_ID), eq(appSettings.version, expectedVersion)))
        .returning({ version: appSettings.version });

      if (!row) return { conflict: true };
      return { version: row.version };
    },
  };
}
