/**
 * Writes an export to disk and tells the user what happened.
 *
 * The path a user picks in a dialog is still untrusted input as far as the filesystem is
 * concerned, so the target is resolved once, checked for collisions, and cleaned up if
 * anything fails partway through — a half-written export is worse than none, because the
 * user cannot tell which files made it.
 */
import * as vscode from 'vscode';
import { exists, mkdirp, removeRecursive, writeText } from '../workspace/fsUtil';
import { fileBaseName, type ExportFile } from './builder';

/** Refuses anything that could escape the target directory. */
function isSafeRelative(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return !path
    .split('/')
    .some((part) => !part || part === '.' || part === '..' || part.includes(':') || part.endsWith(' '));
}

/**
 * Writes `files` under `target`, which must not exist yet.
 *
 * The target is created last: `createDirectory` also creates parents, so creating it inside
 * the try block is what would leave an empty folder behind when a later write fails.
 */
export async function writeExport(target: vscode.Uri, files: ExportFile[]): Promise<vscode.Uri> {
  const bad = files.find((f) => !isSafeRelative(f.path));
  if (bad) throw new Error(`导出路径不合法：${bad.path}`);

  if (await exists(target)) {
    throw new Error(`${target.fsPath} 已经存在，换一个目录或先删掉它。导出不会覆盖已有内容。`);
  }

  // Deduplicate directories so each one is created exactly once, shallowest first.
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }

  await mkdirp(target);
  try {
    for (const dir of [...dirs].sort()) await mkdirp(vscode.Uri.joinPath(target, ...dir.split('/')));
    for (const file of files) {
      const uri = vscode.Uri.joinPath(target, ...file.path.split('/'));
      await writeText(uri, file.content);
    }
  } catch (err) {
    // Remove the half-written tree so the next attempt starts clean.
    await removeRecursive(target).catch(() => undefined);
    throw err;
  }
  return target;
}

/** `订单库-20261005-0930`, unique because the loop stops at the first free name. */
export async function uniqueTargetDir(parent: vscode.Uri, name: string): Promise<vscode.Uri> {
  const base = fileBaseName(name);
  for (let i = 1; i < 1000; i++) {
    const candidate = vscode.Uri.joinPath(parent, i === 1 ? base : `${base}_${i}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`${parent.fsPath} 下已经有太多同名目录了。`);
}

/**
 * The whole export as one text, for pasting into a chat.
 *
 * Built from the same file list that was written, so what is pasted always matches what is
 * on disk. A file path doubles as a section header, which is what an AI needs to navigate.
 */
export function asSingleDocument(files: ExportFile[], title: string): string {
  const parts = [`# ${title}`, '', '以下是设计画布导出的内容，目录结构与画布上的分区一致。', ''];
  for (const file of files) {
    parts.push('', '---', '', `## 文件：${file.path}`, '', '```markdown', file.content.replace(/\r?\n$/, ''), '```', '');
  }
  return parts.join('\n');
}

export interface ExportOutcome {
  target: vscode.Uri;
  readme: vscode.Uri;
  files: ExportFile[];
  counts: { designTables: number; dbTables: number; diagrams: number };
}

/** Notifies and offers the three things a user does next: read it, paste it, or open it. */
export async function reportExport(outcome: ExportOutcome): Promise<void> {
  const { target, readme, files, counts } = outcome;
  const parts = [
    counts.designTables && `${counts.designTables} 张设计表`,
    counts.dbTables && `${counts.dbTables} 张数据表`,
    counts.diagrams && `${counts.diagrams} 张设计图`,
  ].filter(Boolean);
  const summary = `已导出${parts.length ? ` ${parts.join('、')}` : '空目录'}`;
  const choice = await vscode.window.showInformationMessage(summary, { detail: target.fsPath }, '打开 README', '复制给 AI', '打开目录');
  if (choice === '打开 README') await vscode.window.showTextDocument(readme, { preview: false });
  else if (choice === '打开目录') await vscode.env.openExternal(vscode.Uri.file(target.fsPath));
  else if (choice === '复制给 AI') {
    await vscode.env.clipboard.writeText(asSingleDocument(files, target.fsPath.split(/[\\/]/).pop() ?? '导出'));
    void vscode.window.showInformationMessage('已复制，可以直接粘贴给 AI。');
  }
}
