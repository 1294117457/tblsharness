import * as vscode from 'vscode';
import { DIAGRAM_EDITOR_VIEW_TYPE } from '../diagram/diagramEditor';
import { DIAGRAM_TYPES, diagramTypeLabel, emptyDiagram, serializeDiagram, type DiagramFile, type DiagramType } from '../shared/diagram';
import { generateErDiagram } from '../shared/mermaid/er';
import { driverLabel, nextDefaultName } from '../shared/workspace';
import { readText } from '../workspace/fsUtil';
import { confirm, pickSourceId, pickWorkspace, promptName, register, required, revealInTree, type Harness, type NodeArg } from './common';

export interface DiagramCreateArg extends NodeArg {
  type?: DiagramType;
  /** Skip the "generate from tables" question and start with an empty diagram. */
  blank?: boolean;
  /** Where the card goes on the canvas. */
  at?: { x: number; y: number };
}

export function registerDiagramCommands(h: Harness): void {
  register(h, 'harness.diagram.create', async (raw) => {
    const arg = raw as DiagramCreateArg | undefined;
    const ws = await pickWorkspace(h, arg);
    const design = await pickSourceId(h, ws, 'design', arg);
    const partition = arg?.kind === 'partition' ? arg.id : arg?.partition;
    const type =
      arg?.type ??
      required(
        await vscode.window.showQuickPick(
          DIAGRAM_TYPES.map((t) => ({ label: t.label, description: t.syncable ? '可以确认后同步到表结构' : '只用来表达设计，不会改表结构', type: t.type })),
          { title: '新建设计图' },
        ),
      ).type;

    const loaded = await h.store.source(ws.id, 'design', design);
    const schema = loaded.schema;
    let refs: string[] = [];
    let code: string | undefined;
    if (type === 'er' && !arg?.blank && schema?.tables.length) {
      const doc = await h.store.designDoc(ws.id, design);
      const picks = [
        { label: '$(new-file) 空白', description: '自己写，或者复制给 AI 让它写', tables: undefined as string[] | undefined },
        { label: '$(table) 从表结构生成：全部表', description: `${schema.tables.length} 张`, tables: schema.tables.map((t) => t.key) },
        ...(doc.schema.viewpoints ?? []).map((v) => ({
          label: `$(symbol-namespace) 从模块生成：${v.name}`,
          description: `${v.tables?.length ?? 0} 张`,
          tables: (v.tables ?? []).map((t) => schema.tables.find((x) => x.key === t || x.rawName === t)?.key).filter((t): t is string => !!t),
        })),
        { label: '$(checklist) 从表结构生成：选择表…', description: '', tables: [] as string[] },
      ];
      const pick = required(await vscode.window.showQuickPick(picks, { title: '新建 ER 图' }));
      let tables = pick.tables;
      if (tables && !tables.length) {
        const chosen = required(
          await vscode.window.showQuickPick(
            schema.tables.map((t) => ({ label: t.key, description: t.comment, picked: false })),
            { title: '选择要画进 ER 图的表', canPickMany: true },
          ),
        );
        if (!chosen.length) throw new Error('没有选择表');
        tables = chosen.map((c) => c.label);
      }
      if (tables) {
        refs = tables;
        code = generateErDiagram(schema, tables);
      }
    }

    const names = (await h.diagrams.list(ws.id, design)).map((d) => d.file.meta.name);
    const file: DiagramFile = emptyDiagram(type, nextDefaultName(diagramTypeLabel(type), names), refs);
    if (code) file.code = code;
    else if (type === 'er') file.code = 'erDiagram\n  %% 在这里写表，例如：\n  %% users {\n  %%   bigint id PK "主键"\n  %% }';
    const id = await ws.design(design).createDiagram(serializeDiagram(file));
    h.store.invalidate({ workspace: ws.id, kind: 'diagram', id: design, diagram: id });
    await h.canvases.placeDiagram(ws.id, design, id, partition, arg?.at);
    void revealInTree(h, { kind: 'diagram', workspace: ws.id, design, id, partition });
    await h.canvases.open(ws.id, design, { item: { kind: 'diagram', id }, edit: true });
  });

  /** Shows the card on the design canvas; the text is edited in the canvas's right panel. */
  register(h, 'harness.diagram.open', async (arg) => {
    const { ref } = await diagramFromArg(h, arg);
    await h.canvases.open(ref.workspace, ref.design, { item: { kind: 'diagram', id: ref.diagram } });
  });

  register(h, 'harness.diagram.openInTab', async (arg) => {
    const { uri } = await diagramFromArg(h, arg);
    await openDiagram(uri);
  });

  register(h, 'harness.diagram.openText', async (arg) => {
    const { uri } = await diagramFromArg(h, arg);
    await vscode.window.showTextDocument(uri, { preview: false });
  });

  register(h, 'harness.diagram.rename', async (arg) => {
    const { ref } = await diagramFromArg(h, arg);
    const current = await h.diagrams.read(ref);
    const name = await promptName('重命名设计图', current.meta.name);
    await h.diagrams.modify(ref, (f) => ({ ...f, meta: { ...f.meta, name } }));
    h.store.invalidate({ workspace: ref.workspace, kind: 'diagram', id: ref.design, diagram: ref.diagram });
  });

  register(h, 'harness.diagram.delete', async (arg) => {
    const { ref } = await diagramFromArg(h, arg);
    const file = await h.diagrams.read(ref);
    const undoable = h.canvases.isOpen(ref.workspace, ref.design);
    await confirm(`确定删除设计图“${file.meta.name}”吗？`, `只删除这张图，表结构不受影响。${undoable ? '可以在画布中按 Ctrl+Z 撤销。' : '此操作不能撤销。'}`, '删除');
    await h.canvases.deleteDiagram(ref.workspace, ref.design, ref.diagram);
  });

  register(h, 'harness.diagram.copyForAI', async (arg) => {
    const { ref } = await diagramFromArg(h, arg);
    const file = await h.diagrams.read(ref);
    await copyForAI(h, ref.workspace, ref.design, file);
  });

  register(h, 'harness.design.copyForAI', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const design = await pickSourceId(h, ws, 'design', arg);
    await copyForAI(h, ws.id, design);
  });
}

export async function openDiagram(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, DIAGRAM_EDITOR_VIEW_TYPE);
}

async function diagramFromArg(h: Harness, arg?: NodeArg) {
  const ws = await pickWorkspace(h, arg);
  if (arg?.kind === 'diagram' && arg.design && arg.id) {
    const ref = { workspace: ws.id, design: arg.design, diagram: arg.id };
    return { ref, uri: h.diagrams.uri(ref) };
  }
  const design = await pickSourceId(h, ws, 'design', arg);
  const all = await h.diagrams.list(ws.id, design);
  if (!all.length) throw new Error('这个设计库还没有设计图');
  const pick =
    all.length === 1
      ? all[0]
      : required(await vscode.window.showQuickPick(all.map((d) => ({ label: d.file.meta.name, description: diagramTypeLabel(d.file.meta.type), ...d })), { title: '选择设计图' }));
  const ref = { workspace: ws.id, design, diagram: pick.id };
  return { ref, uri: h.diagrams.uri(ref) };
}

/**
 * Puts the Mermaid spec, the current content and a request placeholder on the clipboard.
 * Only model content goes out: design names, tables and diagrams. Never connection details.
 */
export async function copyForAI(h: Harness, workspace: string, design: string, diagram?: DiagramFile): Promise<void> {
  const spec = await readText(vscode.Uri.joinPath(h.context.extensionUri, 'media', 'spec', 'mermaid-design.md'));
  const loaded = await h.store.source(workspace, 'design', design);
  const driver = driverLabel(loaded.schema?.driver?.name) ?? '未指定';
  const parts = [spec.trim(), '', '---', '', `## 当前内容`, '', `设计库：${loaded.name}（目标数据库：${driver}）`];
  if (diagram) {
    parts.push(`设计图：${diagram.meta.name}（${diagramTypeLabel(diagram.meta.type)}）`, '', '```mermaid', diagram.code.trim(), '```');
    if (diagram.meta.type !== 'er' && loaded.schema?.tables.length) {
      const refs = diagram.meta.refs.length ? diagram.meta.refs : loaded.schema.tables.map((t) => t.key);
      parts.push('', '相关的表结构（只读参考）：', '', '```mermaid', generateErDiagram(loaded.schema, refs), '```');
    }
  } else if (loaded.schema?.tables.length) {
    parts.push('', '```mermaid', generateErDiagram(loaded.schema), '```');
  } else {
    parts.push('', '（还没有表，请从零开始设计）');
  }
  parts.push('', '## 我的需求', '', '（在这里写你想让 AI 设计或修改的内容）', '');
  await vscode.env.clipboard.writeText(parts.join('\n'));
  void vscode.window.showInformationMessage('已复制给 AI 的内容：格式说明 + 当前设计。粘贴到对话里，写上你的需求即可。AI 回复的 Mermaid 粘贴回设计图后，在右侧确认同步。');
}
