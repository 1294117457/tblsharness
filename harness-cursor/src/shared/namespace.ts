import { partitionPath, type CanvasFile, type CanvasNamespace, type NamespaceKind } from './canvas';

const SCHEMA_DRIVERS = new Set(['postgres', 'postgresql', 'redshift', 'mssql', 'sqlserver', 'oracle']);

/** Databases with real schemas default to `schema.table`; the rest to a table-name prefix. */
export function defaultNamespaceKind(driver: string | undefined): NamespaceKind {
  return driver && SCHEMA_DRIVERS.has(driver.toLowerCase()) ? 'schema' : 'prefix';
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Returns the stored form (prefixes always end with `_`), or an error message. */
export function normalizeNamespace(kind: NamespaceKind, value: string): CanvasNamespace | string {
  let v = value.trim();
  if (kind === 'schema') {
    if (!IDENT.test(v)) return 'schema 名只能包含字母、数字、下划线，且不能以数字开头';
    return { kind, value: v };
  }
  if (!v.endsWith('_')) v = `${v}_`;
  if (!IDENT.test(v)) return '前缀只能包含字母、数字、下划线，且不能以数字开头';
  return { kind, value: v };
}

/** Namespace in effect at a level: the nearest partition (itself or an ancestor) that sets one. */
export function effectiveNamespace(canvas: CanvasFile, partition: string | undefined): CanvasNamespace | undefined {
  const path = partitionPath(canvas, partition);
  for (let i = path.length - 1; i >= 0; i--) if (path[i].namespace) return path[i].namespace;
  return undefined;
}

export function qualify(ns: CanvasNamespace | undefined, short: string): string {
  if (!ns) return short;
  return ns.kind === 'schema' ? `${ns.value}.${short}` : `${ns.value}${short}`;
}

export function inNamespace(ns: CanvasNamespace | undefined, real: string): boolean {
  if (!ns) return false;
  const head = ns.kind === 'schema' ? `${ns.value}.` : ns.value;
  return real.length > head.length && real.startsWith(head);
}

/** Name shown on the canvas: the real name without the namespace of the level it sits in. */
export function shortName(ns: CanvasNamespace | undefined, real: string): string {
  if (!ns || !inNamespace(ns, real)) return real;
  return real.slice(ns.kind === 'schema' ? ns.value.length + 1 : ns.value.length);
}

export function namespaceLabel(ns: CanvasNamespace): string {
  return ns.kind === 'schema' ? `${ns.value}.` : ns.value;
}

/**
 * Real name for a table landing in `ns`: keeps the short name when possible and appends
 * `_copy`, `_copy2`… only when the real name or the display name at that level is taken.
 */
export function landingName(short: string, ns: CanvasNamespace | undefined, takenReal: Set<string>, takenShort: Set<string>, forceCopy = false): string {
  for (let i = forceCopy ? 1 : 0; ; i++) {
    const s = i === 0 ? short : i === 1 ? `${short}_copy` : `${short}_copy${i}`;
    const real = qualify(ns, s);
    if (!takenReal.has(real) && !takenShort.has(s)) return real;
  }
}

/** `payment` → `payment_copy`, `pay_` → `pay_copy_`, skipping values already used by another partition. */
export function copyNamespace(ns: CanvasNamespace, used: Set<string>): CanvasNamespace {
  const base = ns.kind === 'prefix' ? ns.value.replace(/_$/, '') : ns.value;
  for (let i = 1; ; i++) {
    const stem = i === 1 ? `${base}_copy` : `${base}_copy${i}`;
    const value = ns.kind === 'prefix' ? `${stem}_` : stem;
    if (!used.has(value)) return { kind: ns.kind, value };
  }
}
