import { describe, expect, it } from 'vitest';
import {
  applyCanvasEdit,
  DESIGN_SOURCE,
  emptyCanvas,
  parseCanvas,
  parseNodeId,
  removeDbFromCanvas,
  renameTableInCanvas,
  serializeCanvas,
  type CanvasFile,
} from '../src/shared/canvas';

function sample(): CanvasFile {
  return {
    ...emptyCanvas('c'),
    designTables: 'all',
    nodes: [
      { source: DESIGN_SOURCE, table: 'users', x: 0, y: 0 },
      { source: 'db1', table: 'users', x: 300.4, y: 10.6 },
    ],
    comparison: { db: 'db1', mode: 'overlay' },
  };
}

describe('canvas edits', () => {
  it('nodes.put adds or moves and rounds positions', () => {
    const c = applyCanvasEdit(sample(), [
      { op: 'nodes.put', nodes: [{ source: DESIGN_SOURCE, table: 'users', x: 10.7, y: 5.2 }, { source: DESIGN_SOURCE, table: 'orders', x: 1, y: 2 }] },
    ]);
    expect(c.nodes).toContainEqual({ source: DESIGN_SOURCE, table: 'users', x: 11, y: 5 });
    expect(c.nodes).toHaveLength(3);
  });

  it('nodes.put keeps per-node display settings', () => {
    let c = applyCanvasEdit(sample(), [{ op: 'nodes.display', ids: [`${DESIGN_SOURCE}/users`], display: 'keys' }]);
    c = applyCanvasEdit(c, [{ op: 'nodes.put', nodes: [{ source: DESIGN_SOURCE, table: 'users', x: 50, y: 50 }] }]);
    expect(c.nodes.find((n) => n.source === DESIGN_SOURCE)!.display).toBe('keys');
    c = applyCanvasEdit(c, [{ op: 'nodes.display', ids: [`${DESIGN_SOURCE}/users`] }]);
    expect(c.nodes.find((n) => n.source === DESIGN_SOURCE)).not.toHaveProperty('display');
  });

  it('removeDbFromCanvas removes db nodes and the comparison using it', () => {
    const c = removeDbFromCanvas(sample(), 'db1');
    expect(c.nodes.map((n) => n.source)).toEqual([DESIGN_SOURCE]);
    expect(c.comparison).toBeUndefined();
  });

  it('removeDbFromCanvas returns same object when db not referenced', () => {
    const s = sample();
    expect(removeDbFromCanvas(s, 'db99')).toBe(s);
  });

  it('renames design tables only', () => {
    const c = renameTableInCanvas(sample(), 'users', 'accounts');
    expect(c.nodes.map((n) => `${n.source}/${n.table}`).sort()).toEqual(['db1/users', `${DESIGN_SOURCE}/accounts`]);
    expect(renameTableInCanvas(c, 'nonexistent', 'x')).toBe(c);
  });

  it('parses node ids whose table contains a schema prefix', () => {
    expect(parseNodeId('db1/pgmq.meta')).toEqual({ source: 'db1', table: 'pgmq.meta' });
  });

  it('renames the canvas with meta.set and ignores no-op or blank names', () => {
    const c = sample();
    const renamed = applyCanvasEdit(c, [{ op: 'meta.set', name: '  下单流程 ' }]);
    expect(renamed.name).toBe('下单流程');
    expect(applyCanvasEdit(renamed, [{ op: 'meta.set', name: '下单流程' }])).toBe(renamed);
    expect(applyCanvasEdit(renamed, [{ op: 'meta.set', name: '   ' }])).toBe(renamed);
    expect(applyCanvasEdit(renamed, [{ op: 'meta.set', description: '说明' }]).description).toBe('说明');
  });

  it('designTables.set changes the mode', () => {
    const c = sample();
    const picked = applyCanvasEdit(c, [{ op: 'designTables.set', mode: 'picked' }]);
    expect(picked.designTables).toBe('picked');
    expect(applyCanvasEdit(picked, [{ op: 'designTables.set', mode: 'picked' }])).toBe(picked);
  });

  it('zone.put adds or updates zones', () => {
    const c = applyCanvasEdit(sample(), [{ op: 'zone.put', zone: { id: 'z1', name: '用户', x: 0, y: 0, width: 500, height: 400 } }]);
    expect(c.zones).toHaveLength(1);
    expect(c.zones[0].name).toBe('用户');
    const updated = applyCanvasEdit(c, [{ op: 'zone.put', zone: { id: 'z1', name: '订单', x: 10, y: 10, width: 600, height: 500 } }]);
    expect(updated.zones).toHaveLength(1);
    expect(updated.zones[0].name).toBe('订单');
  });

  it('zone.remove removes a zone', () => {
    const c = applyCanvasEdit(sample(), [
      { op: 'zone.put', zone: { id: 'z1', name: 'A', x: 0, y: 0, width: 100, height: 100 } },
      { op: 'zone.put', zone: { id: 'z2', name: 'B', x: 200, y: 0, width: 100, height: 100 } },
    ]);
    const after = applyCanvasEdit(c, [{ op: 'zone.remove', id: 'z1' }]);
    expect(after.zones).toHaveLength(1);
    expect(after.zones[0].id).toBe('z2');
  });
});

describe('canvas files', () => {
  it('round-trips and serializes stably', () => {
    const text = serializeCanvas(sample());
    const again = serializeCanvas(parseCanvas(text));
    expect(again).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text).nodes[0]).toMatchObject({ source: 'db1', x: 300, y: 11 });
  });

  it('fills defaults for empty or partial files', () => {
    const c = parseCanvas('');
    expect(c).toMatchObject({ version: 2, nodes: [], notes: [], settings: { columnDisplay: 'all' } });
    expect(c.designTables).toBe('picked');
    expect(c.zones).toEqual([]);
  });
});
