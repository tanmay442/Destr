import { describe, expect, it } from 'vitest';
import { __test } from './verify-identifier-width';

const validSchema = {
  columns: [
    { table_name: 'audit_events', data_type: 'bigint' },
    { table_name: 'chat_events', data_type: 'bigint' },
    { table_name: 'quality_reviews', data_type: 'bigint' },
    { table_name: 'tickets', data_type: 'bigint' },
  ],
  sequences: [
    { sequence_name: 'audit_events_id_seq', data_type: 'bigint' },
    { sequence_name: 'chat_events_id_seq', data_type: 'bigint' },
    { sequence_name: 'quality_reviews_id_seq', data_type: 'bigint' },
    { sequence_name: 'tickets_id_seq', data_type: 'bigint' },
  ],
  defaults: [
    { table_name: 'audit_events', column_default: "nextval('audit_events_id_seq'::regclass)" },
    { table_name: 'chat_events', column_default: "nextval('chat_events_id_seq'::regclass)" },
    { table_name: 'quality_reviews', column_default: "nextval('quality_reviews_id_seq'::regclass)" },
    { table_name: 'tickets', column_default: "nextval('tickets_id_seq'::regclass)" },
  ],
  foreignKeys: [
    'chat_events_turn_id_chat_turns_turn_id_fk',
    'chat_feedback_turn_id_chat_turns_turn_id_fk',
    'quality_reviews_reviewer_id_users_clerk_user_id_fk',
    'quality_reviews_turn_id_chat_turns_turn_id_fk',
  ],
};

describe('identifier-width verification helpers', () => {
  it('defaults to both fresh and seeded-upgrade checks', () => {
    expect(__test.parseModes([])).toEqual(['fresh', 'upgrade']);
    expect(__test.parseModes(['--upgrade', '--upgrade'])).toEqual(['upgrade']);
    expect(__test.parseModes(['--fresh'])).toEqual(['fresh']);
  });

  it('rejects unknown verification modes', () => {
    expect(() => __test.parseModes(['--rollback'])).toThrow(/Unknown option/);
  });

  it('accepts the expected widened schema shape', () => {
    expect(() => __test.assertWidenedSchema(validSchema)).not.toThrow();
  });

  it('rejects an int4 column or missing owned sequence', () => {
    const invalid = {
      ...validSchema,
      columns: validSchema.columns.map((column) => (
        column.table_name === 'tickets' ? { ...column, data_type: 'integer' } : column
      )),
    };
    expect(() => __test.assertWidenedSchema(invalid)).toThrow(/Expected bigint IDs/);
  });

  it('targets a temporary database while retaining connection options', () => {
    expect(__test.databaseUrlFor('postgres://u:p@localhost/ragagent?sslmode=require', 'tmp_db'))
      .toBe('postgres://u:p@localhost/tmp_db?sslmode=require');
    expect(__test.tempDatabaseName('upgrade')).toMatch(/^destr_identifier_upgrade_[a-zA-Z0-9_]+$/u);
  });
});
