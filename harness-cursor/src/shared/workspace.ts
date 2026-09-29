import type { ConnectionDriver } from './connection';

export type SourceKind = 'design' | 'db';

export type SeqKind = 'design' | 'db';

export interface WorkspaceMeta {
  version: 1;
  name: string;
  description?: string;
  /** Last number handed out per kind; ids are never reused, even after deletion. */
  seq?: Partial<Record<SeqKind, number>>;
}

/** `<root>/harness.json` */
export interface HarnessRootMeta {
  version: 1;
  seq: { workspace?: number };
}

export interface DesignMeta {
  version: 1;
  name: string;
  description?: string;
  createdFrom?: { kind: 'empty' } | { kind: 'db'; source: string; snapshot: string } | { kind: 'file'; path: string };
  /** Database IDs referenced by this design (画布 can show their tables). */
  sources?: string[];
  /** Last number handed out per sub-kind inside this design. */
  seq?: { canvas?: number; diagram?: number };
  /** Canvas ID last opened; used to decide which canvas to open when clicking the design node. */
  lastCanvas?: string;
}


export interface DbSourceMeta {
  version: 1;
  name: string;
  description?: string;
  /**
   * secret: host, user, password etc. live in the OS credential store; only the database type is kept here.
   * none: offline, snapshots are imported from files.
   */
  connection: { kind: 'secret'; driver?: ConnectionDriver } | { kind: 'none' };
  defaultSchema?: string;
  exclude: string[];
  include: string[];
  snapshotRetention: number;
}

/** Per-design comparisons: keyed by database ID. */
export interface ComparisonsFile {
  version: 1;
  dbs: Record<string, ComparisonEntry>;
}

export interface ComparisonEntry {
  tableMappings?: Record<string, string>;
  acceptedDiffs?: string[];
}


export const DEFAULT_DB_EXCLUDE = [
  'pg_stat_statements',
  'pg_stat_statements_info',
  'spatial_ref_sys',
  'geography_columns',
  'geometry_columns',
  'raster_columns',
  'raster_overviews',
  'part_config',
  'part_config_sub',
  'pgmq.*',
  'topology.*',
  'cron.*',
  'flyway_schema_history',
  'databasechangelog',
  'databasechangeloglock',
];

export const DEFAULT_SNAPSHOT_RETENTION = 10;

/** Target databases offered when creating a design; values are tbls driver names. */
export const DESIGN_DRIVERS: { name: string; label: string }[] = [
  { name: 'postgres', label: 'PostgreSQL' },
  { name: 'mysql', label: 'MySQL' },
  { name: 'mariadb', label: 'MariaDB' },
  { name: 'sqlite', label: 'SQLite' },
  { name: 'sqlserver', label: 'SQL Server' },
  { name: 'oracle', label: 'Oracle' },
  { name: 'other', label: '其他' },
];

export function driverLabel(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return DESIGN_DRIVERS.find((d) => d.name === name)?.label ?? name;
}

export const ID_PREFIX: Record<SeqKind | 'workspace' | 'canvas' | 'diagram', string> = {
  workspace: 'workspace',
  design: 'design',
  db: 'db',
  canvas: 'canvas',
  diagram: 'diagram',
};

/**
 * Next number for `<prefix><N>` ids: one past both the recorded counter and every existing id,
 * so a lost or stale counter can never hand out an id that is still on disk.
 */
export function nextSeq(prefix: string, existingIds: Iterable<string>, recorded?: number): number {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = recorded && recorded > 0 ? Math.floor(recorded) : 0;
  for (const id of existingIds) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** "工作区 1", "工作区 2"…: one past the highest number among names of that exact form. */
export function nextDefaultName(base: string, existingNames: Iterable<string>): string {
  const pattern = new RegExp(`^${escapeRegExp(base)} (\\d+)$`);
  let max = 0;
  for (const name of existingNames) {
    const m = pattern.exec(name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base} ${max + 1}`;
}

/** "PostgreSQL · orders" → "PostgreSQL · orders (2)" when the name is already taken. */
export function uniqueName(name: string, existingNames: Iterable<string>): string {
  const taken = new Set([...existingNames].map((n) => n.trim()));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateId(id: string, existing: Iterable<string>): string | undefined {
  if (!ID_PATTERN.test(id)) {
    return 'ID 只能包含小写字母、数字、- 和 _，以字母或数字开头，最长 64 个字符';
  }
  for (const e of existing) {
    if (e === id) {
      return `ID ${id} 已存在`;
    }
  }
  return undefined;
}