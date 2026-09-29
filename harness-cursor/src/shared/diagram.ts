import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type DiagramType = 'er' | 'state' | 'sequence' | 'flow' | 'dataflow';

export const DIAGRAM_TYPES: { type: DiagramType; label: string; header: string; syncable: boolean }[] = [
  { type: 'er', label: 'ER 图', header: 'erDiagram', syncable: true },
  { type: 'state', label: '状态图', header: 'stateDiagram-v2', syncable: false },
  { type: 'sequence', label: '时序图', header: 'sequenceDiagram', syncable: false },
  { type: 'flow', label: '流程图', header: 'flowchart TD', syncable: false },
  { type: 'dataflow', label: '数据流图', header: 'flowchart LR', syncable: false },
];

export function diagramTypeLabel(type: DiagramType): string {
  return DIAGRAM_TYPES.find((t) => t.type === type)?.label ?? type;
}

/** Frontmatter of `design/<id>/diagrams/<diagramN>.md`. */
export interface DiagramMeta {
  type: DiagramType;
  name: string;
  description?: string;
  /** Tables of the design this diagram belongs to; the scope for detecting deletions. */
  refs: string[];
  /** state diagrams: `table.column` holding the state. */
  bind?: string;
  /** Sync item ids the user chose to ignore. */
  ignored: string[];
  /** Node positions for the graphical editor; kept verbatim until that editor exists. */
  layout?: Record<string, unknown>;
}

export interface DiagramFile {
  meta: DiagramMeta;
  /** Content of the first ```mermaid block, without the fences. */
  code: string;
  /** Markdown between the frontmatter and the mermaid block, kept verbatim. */
  before: string;
  /** Markdown after the mermaid block, kept verbatim. */
  after: string;
  /** Problems found while reading; the file is still usable. */
  problems: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MERMAID_BLOCK = /(^|\n)(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)\n?\2[ \t]*(?=\n|$)/;

export function emptyDiagram(type: DiagramType, name: string, refs: string[] = []): DiagramFile {
  const header = DIAGRAM_TYPES.find((t) => t.type === type)?.header ?? 'erDiagram';
  return { meta: { type, name, refs, ignored: [] }, code: header, before: '\n', after: '', problems: [] };
}

export function guessDiagramType(code: string): DiagramType | undefined {
  const first = code
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'));
  if (!first) return undefined;
  if (/^erDiagram\b/.test(first)) return 'er';
  if (/^stateDiagram(-v2)?\b/.test(first)) return 'state';
  if (/^sequenceDiagram\b/.test(first)) return 'sequence';
  if (/^(flowchart|graph)\s+(LR|RL)\b/.test(first)) return 'dataflow';
  if (/^(flowchart|graph)\b/.test(first)) return 'flow';
  return undefined;
}

export function parseDiagram(text: string, fallbackName = '设计图'): DiagramFile {
  const problems: string[] = [];
  let raw: Record<string, unknown> = {};
  let body = text;
  const fm = FRONTMATTER.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    try {
      const parsed = parseYaml(fm[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
      else if (parsed != null) problems.push('开头的 --- 区域不是键值格式，已忽略');
    } catch (err) {
      problems.push(`开头的 --- 区域不是合法的 YAML：${(err as Error).message.split('\n')[0]}`);
    }
  }

  let code = '';
  let before = body;
  let after = '';
  const block = MERMAID_BLOCK.exec(body);
  if (block) {
    const start = block.index + block[1].length;
    before = body.slice(0, start);
    code = block[3];
    after = body.slice(block.index + block[0].length);
  } else if (guessDiagramType(body)) {
    code = body.replace(/\s+$/, '');
    before = '\n';
  } else if (body.trim()) {
    problems.push('没有找到 ```mermaid 代码块');
  }

  const typeRaw = String(raw.type ?? '');
  const type = (DIAGRAM_TYPES.some((t) => t.type === typeRaw) ? typeRaw : guessDiagramType(code) ?? 'er') as DiagramType;
  if (raw.type !== undefined && typeRaw !== type) problems.push(`不认识的设计图类型 ${typeRaw}，按 ${diagramTypeLabel(type)} 处理`);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);
  const meta: DiagramMeta = {
    type,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName,
    refs: strings(raw.refs),
    ignored: strings(raw.ignored),
  };
  if (typeof raw.description === 'string' && raw.description) meta.description = raw.description;
  if (typeof raw.bind === 'string' && raw.bind) meta.bind = raw.bind;
  if (raw.layout && typeof raw.layout === 'object' && !Array.isArray(raw.layout)) meta.layout = raw.layout as Record<string, unknown>;
  return { meta, code, before, after, problems };
}

export function serializeDiagram(file: DiagramFile): string {
  const m = file.meta;
  const out: Record<string, unknown> = { type: m.type, name: m.name };
  if (m.description) out.description = m.description;
  out.refs = m.refs;
  if (m.bind) out.bind = m.bind;
  if (m.ignored.length) out.ignored = m.ignored;
  if (m.layout && Object.keys(m.layout).length) out.layout = m.layout;
  const yaml = stringifyYaml(out, { lineWidth: 0 });
  const before = file.before || '\n';
  const code = file.code.replace(/\s+$/, '');
  const after = file.after && !file.after.startsWith('\n') ? `\n${file.after}` : file.after;
  return `---\n${yaml}---\n${before}\`\`\`mermaid\n${code}\n\`\`\`${after || '\n'}`;
}
