import { describe, expect, it } from 'vitest';
import { normalize } from '../src/model/normalize';
import { diffSchemas } from '../src/diff/diff';
import { exampleDb, exampleDesign } from '../webview-ui/src/dev/fixtures';

describe('browser mock fixtures', () => {
  it('build and show every kind of drift the canvas can display', () => {
    const d = exampleDesign();
    const design = normalize(d.schema, { source: 'design', ext: d.ext });
    const db = normalize(exampleDb(), { source: 'db' });
    expect(design.tables).toHaveLength(5);
    expect(design.relations.find((r) => r.kind === 'json_array')).toBeDefined();
    const kinds = new Set(diffSchemas(design, db).items.map((i) => i.kind));
    expect([...kinds].sort()).toEqual([
      'column_mismatch',
      'column_missing_in_db',
      'relation_missing_in_db',
      'table_missing_in_design',
    ]);
  });
});
