import * as vscode from 'vscode';
import { parse, stringify } from 'yaml';

const fs = vscode.workspace.fs;

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder('utf-8').decode(await fs.readFile(uri));
}

export async function readTextIfExists(uri: vscode.Uri): Promise<string | undefined> {
  return (await exists(uri)) ? readText(uri) : undefined;
}

export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await fs.writeFile(uri, new TextEncoder().encode(text));
}

export async function readJson<T>(uri: vscode.Uri): Promise<T> {
  const text = await readText(uri);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${uri.fsPath} 不是合法的 JSON：${(err as Error).message}`);
  }
}

export async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  await writeText(uri, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readYaml<T>(uri: vscode.Uri): Promise<Partial<T>> {
  const text = await readTextIfExists(uri);
  return ((text && parse(text)) ?? {}) as Partial<T>;
}

export async function writeYaml(uri: vscode.Uri, value: unknown): Promise<void> {
  await writeText(uri, stringify(value, { lineWidth: 0 }));
}

export async function listDirectories(uri: vscode.Uri): Promise<string[]> {
  const stat = await Promise.race([
    fs.stat(uri).then((s) => ({ ok: true as const, s }), (e: unknown) => ({ ok: false as const, e })),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stat(${uri.fsPath}) timed out after 5s`)), 5000)),
  ]);
  if (!stat.ok) return [];
  // FileType is a bitfield; treat any directory bit as "is a directory".
  if (!(stat.s.type & vscode.FileType.Directory)) return [];
  const entries = await fs.readDirectory(uri);
  return entries.filter(([, type]) => type & vscode.FileType.Directory).map(([name]) => name).sort();
}

export async function listFiles(uri: vscode.Uri, suffix: string): Promise<string[]> {
  const stat = await Promise.race([
    fs.stat(uri).then((s) => ({ ok: true as const, s }), (e: unknown) => ({ ok: false as const, e })),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stat(${uri.fsPath}) timed out after 5s`)), 5000)),
  ]);
  if (!stat.ok) return [];
  if (!(stat.s.type & vscode.FileType.Directory)) return [];
  const entries = await fs.readDirectory(uri);
  return entries.filter(([name, type]) => (type & vscode.FileType.File) !== 0 && name.endsWith(suffix)).map(([name]) => name).sort();
}

export async function mkdirp(uri: vscode.Uri): Promise<void> {
  await fs.createDirectory(uri);
}

export async function removeRecursive(uri: vscode.Uri): Promise<void> {
  if (await exists(uri)) {
    await fs.delete(uri, { recursive: true, useTrash: false });
  }
}
