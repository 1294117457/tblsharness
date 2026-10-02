import { describe, expect, it } from 'vitest';
import {
  applyCanvasEdit,
  DESIGN_SOURCE,
  emptyCanvas,
  nextPartitionId,
  parseCanvas,
  parseNodeId,
  partitionContents,
  partitionPath,
  removeDbFromCanvas,
  renameTableInCanvas,
  serializeCanvas,
  type CanvasFile,
} from '../src/shared/canvas';

function sample(): CanvasFile {
  return {
    ...emptyCanvas(),
    partitions: [
      { id: 'part1', name: '订单', x: 600, y: 0 },
      { id: 'part2', name: '支付', parent: 'part1', x: 40, y: 320, namespace: { kind: 'schema', value: 'payment' } },
    ],
    nodes: [
      { source: DESIGN_SOURCE, table: 'users', x: 0, y: 0 },
      { source: DESIGN_SOURCE, table: 'orders', x: 20, y: 40, partition: 'part1' },
      { source: DESIGN_SOURCE, table: 'payment.bills', x: 20, y: 40, partition: 'part2' },
      { source: 'db1', table: 'users', x: 300.4, y: 10.6, partition: 'part1' },
    ],
    diagrams: [{ id: 'diagram1', x: 0, y: 400, width: 360, height: 240, partition: 'part2' }],
    notes: [{ id: 'n1', text: 'hi', x: 0, y: 0, width: 200, partition: 'part2' }],
    comparison: { db: 'db1', mode: 'overlay' },
  };
}

describe('canvas edits', () => {
  it('nodes.put adds or moves, rounds positions and keeps the partition', () => {
    const c = applyCanvasEdit(sample(), [
      { op: 'nodes.put', nodes: [{ source: DESIGN_SOURCE, table: 'orders', x: 10.7, y: 5.2 }, { source: DESIGN_SOURCE, table: 'items', x: 1, y: 2 }] },
    ]);
    expect(c.nodes).toContainEqual({ source: DESIGN_SOURCE, table: 'orders', x: 11, y: 5, partition: 'part1' });
    expect(c.nodes).toHaveLength(5);
  });

  it('nodes.display sets and clears per-node display', () => {
    let c = applyCanvasEdit(sample(), [{ op: 'nodes.display', ids: [`${DESIGN_SOURCE}/users`], display: 'keys' }]);
    expect(c.nodes.find((n) => n.table === 'users' && n.source === DESIGN_SOURCE)!.display).toBe('keys');
    c = applyCanvasEdit(c, [{ op: 'nodes.display', ids: [`${DESIGN_SOURCE}/users`] }]);
    expect(c.nodes.find((n) => n.table === 'users' && n.source === DESIGN_SOURCE)).not.toHaveProperty('display');
  });

  it('hidden.set hides implicit tables and diagrams by creating entries, and shows them again', () => {
    const s = sample();
    const hidden = applyCanvasEdit(s, [{ op: 'hidden.set', hidden: true, items: [{ kind: 'table', id: 'design/logs' }, { kind: 'diagram', id: 'diagram9' }] }]);
    expect(hidden.nodes.find((n) => n.table === 'logs')).toMatchObject({ hidden: true });
    expect(hidden.diagrams.find((d) => d.id === 'diagram9')).toMatchObject({ hidden: true });
    const shown = applyCanvasEdit(hidden, [{ op: 'hidden.set', hidden: false, items: [{ kind: 'table', id: 'design/logs' }] }]);
    expect(shown.nodes.find((n) => n.table === 'logs')).not.toHaveProperty('hidden');
    expect(applyCanvasEdit(s, [{ op: 'hidden.set', hidden: false, items: [{ kind: 'table', id: 'design/nope' }] }])).toBe(s);
  });

  it('move changes the level of tables, diagrams, notes and partitions', () => {
    const c = applyCanvasEdit(sample(), [
      {
        op: 'move',
        items: [
          { kind: 'table', id: 'design/users', partition: 'part2', x: 5, y: 6 },
          { kind: 'diagram', id: 'diagram1', partition: null, x: 1, y: 2 },
          { kind: 'note', id: 'n1', partition: 'part1', x: 0, y: 0 },
          { kind: 'table', id: 'design/implicit', partition: 'part1', x: 3, y: 3 },
        ],
      },
    ]);
    expect(c.nodes.find((n) => n.source === DESIGN_SOURCE && n.table === 'users')).toMatchObject({ partition: 'part2', x: 5, y: 6 });
    expect(c.diagrams[0]).not.toHaveProperty('partition');
    expect(c.notes[0].partition).toBe('part1');
    expect(c.nodes.find((n) => n.table === 'implicit')!.partition).toBe('part1');
  });

  it('refuses to move a partition into itself or its descendants, or to a missing partition', () => {
    const s = sample();
    expect(applyCanvasEdit(s, [{ op: 'move', items: [{ kind: 'partition', id: 'part1', partition: 'part2', x: 0, y: 0 }] }])).toBe(s);
    expect(applyCanvasEdit(s, [{ op: 'move', items: [{ kind: 'partition', id: 'part1', partition: 'part1', x: 0, y: 0 }] }])).toBe(s);
    expect(applyCanvasEdit(s, [{ op: 'move', items: [{ kind: 'table', id: 'design/users', partition: 'part9', x: 0, y: 0 }] }])).toBe(s);
    const out = applyCanvasEdit(s, [{ op: 'move', items: [{ kind: 'partition', id: 'part2', partition: null, x: 0, y: 0 }] }]);
    expect(out.partitions.find((p) => p.id === 'part2')).not.toHaveProperty('parent');
  });

  it('partition.put allocates ids that are never reused', () => {
    const s = sample();
    expect(nextPartitionId(s)).toBe('part3');
    const added = applyCanvasEdit(s, [{ op: 'partition.put', partition: { id: 'part3', name: '新分区', x: 0, y: 0 } }]);
    expect(added.seq).toBe(3);
    const removed = applyCanvasEdit(added, [{ op: 'partition.remove', id: 'part3' }]);
    expect(nextPartitionId(removed)).toBe('part4');
    expect(applyCanvasEdit(s, [{ op: 'partition.put', partition: { id: 'part5', name: 'x', parent: 'part9', x: 0, y: 0 } }])).toBe(s);
  });

  it('partition.put stores and rounds width/height, and they round-trip through serialize/parse', () => {
    const s = sample();
    const resized = applyCanvasEdit(s, [{ op: 'partition.put', partition: { id: 'part1', name: '订单', x: 600, y: 0, width: 520.7, height: 360.4 } }]);
    expect(resized.partitions.find((p) => p.id === 'part1')).toMatchObject({ width: 521, height: 360 });
    const text = serializeCanvas(resized);
    const parsed = parseCanvas(text);
    expect(parsed.partitions.find((p) => p.id === 'part1')).toMatchObject({ width: 521, height: 360 });
  });

  it('partition.remove drops the subtree and everything placed in it', () => {
    const s = sample();
    expect(partitionContents(s, 'part1')).toEqual({
      partitions: ['part1', 'part2'],
      designTables: ['orders', 'payment.bills'],
      dbNodes: ['db1/users'],
      diagrams: ['diagram1'],
      notes: 1,
    });
    const c = applyCanvasEdit(s, [{ op: 'partition.remove', id: 'part1' }]);
    expect(c.partitions).toEqual([]);
    expect(c.nodes.map((n) => n.table)).toEqual(['users']);
    expect(c.diagrams).toEqual([]);
    expect(c.notes).toEqual([]);
  });

  it('partitionPath walks from the root down', () => {
    expect(partitionPath(sample(), 'part2').map((p) => p.id)).toEqual(['part1', 'part2']);
    expect(partitionPath(sample(), undefined)).toEqual([]);
  });

  it('removeDbFromCanvas removes db nodes and the comparison using it', () => {
    const c = removeDbFromCanvas(sample(), 'db1');
    expect(c.nodes.every((n) => n.source === DESIGN_SOURCE)).toBe(true);
    expect(c.comparison).toBeUndefined();
    const s = sample();
    expect(removeDbFromCanvas(s, 'db99')).toBe(s);
  });

  it('renames design tables only', () => {
    const c = renameTableInCanvas(sample(), 'users', 'accounts');
    expect(c.nodes.map((n) => `${n.source}/${n.table}`)).toContain('design/accounts');
    expect(c.nodes.map((n) => `${n.source}/${n.table}`)).toContain('db1/users');
    expect(renameTableInCanvas(c, 'nonexistent', 'x')).toBe(c);
  });

  it('parses node ids whose table contains a schema prefix', () => {
    expect(parseNodeId('db1/pgmq.meta')).toEqual({ source: 'db1', table: 'pgmq.meta' });
  });
});

describe('layout files', () => {
  it('round-trips and serializes stably', () => {
    const text = serializeCanvas({ ...sample(), viewports: { root: { x: 1.234, y: 2, zoom: 0.5 } } });
    expect(serializeCanvas(parseCanvas(text))).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text).nodes[0]).toMatchObject({ source: 'db1', x: 300, y: 11 });
  });

  it('fills defaults for empty or partial files and drops dangling partition references', () => {
    expect(parseCanvas('')).toMatchObject({ version: 3, partitions: [], nodes: [], diagrams: [], notes: [], settings: { columnDisplay: 'all' } });
    const c = parseCanvas(JSON.stringify({ partitions: [{ id: 'part1', name: 'A', parent: 'part7' }], nodes: [{ source: 'design', table: 't', partition: 'part9' }] }));
    expect(c.partitions[0]).not.toHaveProperty('parent');
    expect(c.nodes[0]).not.toHaveProperty('partition');
  });
});
