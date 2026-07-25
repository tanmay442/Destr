import { describe, it, expect } from 'vitest';
import { flattenSchema, NON_EDITABLE_FIELDS } from './descriptor';
import { fieldConfig } from './field-config';

describe('fieldConfig coverage', () => {
  it('covers every editable AppConfig field', () => {
    const editable = [...flattenSchema().keys()].filter(
      (key) => !(NON_EDITABLE_FIELDS as readonly string[]).includes(key),
    );
    const configured = new Set(Object.keys(fieldConfig));
    const missing = editable.filter((key) => !configured.has(key));
    expect(missing).toEqual([]);
  });

  it('does not configure non-editable fields', () => {
    for (const key of NON_EDITABLE_FIELDS) {
      expect(fieldConfig[key]).toBeUndefined();
    }
  });
});
