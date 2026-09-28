import { describe, expect, it } from 'vitest';
import { applyCanvasEdit, emptyCanvas, nextAlias, parseCanvas, parseNodeId, renameTableInCanvas, serializeCanvas, type CanvasFile } from '../src/shared/canvas';

function sample(): CanvasFile {
  return {
    ...emptyCanvas('c'),
    sources: [
      { alias: 'd1', kind: 'design', ref: 'shop', tables: 'all' },
      { alias: 'b1', kind: 'db', ref: 'prod', tables: 'picked' },
    ],
    nodes: [
      { source: 'd1', table: 'users', x: 0, y: 0 },
      { source: 'b1', table: 'users', x: 300.4, y: 10.6 },
    ],
    comparison: { design: 'd1', db: 'b1', mode: 'overlay' },
  };
}

describe('canvas edits', () => {
  it('returns the same object when nothing changes', () => {
    const c = sample();
    expect(applyCanvasEdit(c, [{ op: 'source.add', source: { alias: 'd2', kind: 'design', ref: 'shop', tables: 'all' } }])).toBe(c);
  });

  it('nodes.put adds or moves and rounds positions', () => {
    const c = applyCanvasEdit(sample(), [
      { op: 'nodes.put', nodes: [{ source: 'd1', table: 'users', x: 10.7, y: 5.2 }, { source: 'd1', table: 'orders', x: 1, y: 2 }] },
    ]);
    expect(c.nodes).toContainEqual({ source: 'd1', table: 'users', x: 11, y: 5 });
    expect(c.nodes).toHaveLength(3);
  });

  it('nodes.put keeps per-node display settings', () => {
    let c = applyCanvasEdit(sample(), [{ op: 'nodes.display', ids: ['d1/users'], display: 'keys' }]);
    c = applyCanvasEdit(c, [{ op: 'nodes.put', nodes: [{ source: 'd1', table: 'users', x: 50, y: 50 }] }]);
    expect(c.nodes.find((n) => n.source === 'd1')!.display).toBe('keys');
    c = applyCanvasEdit(c, [{ op: 'nodes.display', ids: ['d1/users'] }]);
    expect(c.nodes.find((n) => n.source === 'd1')).not.toHaveProperty('display');
  });

  it('removing a source removes its nodes and the comparison using it', () => {
    const c = applyCanvasEdit(sample(), [{ op: 'source.remove', alias: 'b1' }]);
    expect(c.nodes.map((n) => n.source)).toEqual(['d1']);
    expect(c.comparison).toBeUndefined();
  });

  it('renames tables only in sources that reference the design', () => {
    const c = renameTableInCanvas(sample(), 'design', 'shop', 'users', 'accounts');
    expect(c.nodes.map((n) => `${n.source}/${n.table}`).sort()).toEqual(['b1/users', 'd1/accounts']);
    expect(renameTableInCanvas(c, 'design', 'other', 'accounts', 'x')).toBe(c);
  });

  it('picks the next free alias per kind', () => {
    expect(nextAlias(sample(), 'design')).toBe('d2');
    expect(nextAlias(sample(), 'db')).toBe('b2');
  });

  it('parses node ids whose table contains a schema prefix', () => {
    expect(parseNodeId('b1/pgmq.meta')).toEqual({ alias: 'b1', table: 'pgmq.meta' });
  });

  it('renames the canvas with meta.set and ignores no-op or blank names', () => {
    const c = sample();
    const renamed = applyCanvasEdit(c, [{ op: 'meta.set', name: '  下单流程 ' }]);
    expect(renamed.name).toBe('下单流程');
    expect(applyCanvasEdit(renamed, [{ op: 'meta.set', name: '下单流程' }])).toBe(renamed);
    expect(applyCanvasEdit(renamed, [{ op: 'meta.set', name: '   ' }])).toBe(renamed);
    expect(applyCanvasEdit(renamed, [{ op: 'meta.set', description: '说明' }]).description).toBe('说明');
  });
});

describe('canvas files', () => {
  it('round-trips and serializes stably', () => {
    const text = serializeCanvas(sample());
    const again = serializeCanvas(parseCanvas(text));
    expect(again).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text).nodes[0]).toMatchObject({ source: 'b1', x: 300, y: 11 });
  });

  it('fills defaults for empty or partial files', () => {
    const c = parseCanvas('');
    expect(c).toMatchObject({ version: 1, sources: [], nodes: [], notes: [], settings: { columnDisplay: 'all' } });
    const partial = parseCanvas(JSON.stringify({ name: 'x', sources: [{ alias: 'd1', kind: 'design', ref: 'a' }], nodes: [{ source: 'd1' }] }));
    expect(partial.sources[0].tables).toBe('picked');
    expect(partial.nodes).toEqual([]);
  });
});
