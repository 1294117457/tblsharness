import type { DesignOp } from './designOps';
import type { ErProblem } from './mermaid/er';

/** One change a diagram proposes to the design's tables. Never applied without the user's confirmation. */
export interface SyncItem {
  /** Stable across edits of the diagram so `ignored` and checkboxes survive re-detection. */
  id: string;
  action: 'add' | 'change' | 'delete';
  target: 'table' | 'column' | 'relation';
  table: string;
  column?: string;
  message: string;
  detail?: string;
  defaultChecked: boolean;
  /** Items that must be applied together with this one, e.g. the new table a new relation points to. */
  requires?: string[];
  /** The child column of a relation could not be inferred; the user picks one. */
  choice?: { label: string; options: string[]; value?: string };
  /** Missing while `choice` has no value. */
  ops?: DesignOp[];
  /** Application order: tables before columns before relations, deletions last. */
  order: number;
}

export interface SyncResult {
  items: SyncItem[];
  problems: ErProblem[];
  ignored: number;
}

/** Diagrams of one design, as shown in the "待同步" / "与表结构的差异" panels. */
export interface SyncGroup {
  workspace: string;
  design: string;
  designName: string;
  diagram: string;
  diagramName: string;
  result: SyncResult;
  error?: string;
}

export interface SyncSelection {
  ids: string[];
  /** item id -> chosen option. */
  choices: Record<string, string>;
}

export class SyncError extends Error {}

/** Selected items in application order. Throws when something selected is incomplete or missing a dependency. */
export function collectSyncOps(items: SyncItem[], ids: string[]): DesignOp[] {
  const chosen = new Set(ids);
  const byId = new Map(items.map((i) => [i.id, i]));
  const selected = items.filter((i) => chosen.has(i.id));
  for (const id of ids) {
    if (!byId.has(id)) throw new SyncError('设计图已经变化，请重新确认要同步的内容');
  }
  for (const item of selected) {
    if (!item.ops) throw new SyncError(`${item.message}：${item.choice?.label ?? '信息不完整'}`);
    for (const dep of item.requires ?? []) {
      if (byId.has(dep) && !chosen.has(dep)) throw new SyncError(`${item.message} 需要同时勾选：${byId.get(dep)!.message}`);
    }
  }
  return selected.sort((a, b) => a.order - b.order).flatMap((i) => i.ops!);
}
