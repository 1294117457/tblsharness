import { execFile } from 'node:child_process';
import { parseDocument } from 'yaml';
import type { TblsSchema } from '../shared/tbls';

export interface TblsOutOptions {
  tblsPath: string;
  dsn: string;
  configPath?: string;
  exclude: string[];
  include: string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra strings to mask in error output, e.g. the raw (unencoded) password. */
  secrets?: string[];
}

export class TblsError extends Error {
  constructor(
    message: string,
    readonly reason?: 'notFound' | 'timeout' | 'cancelled',
  ) {
    super(message);
  }
}

const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/**
 * Runs `tbls out -t json --sort` and returns both the raw text (kept as the snapshot) and the parsed schema.
 * The DSN goes through the TBLS_DSN environment variable: command-line arguments are visible to every
 * process on the machine.
 */
export async function tblsOutJson(options: TblsOutOptions): Promise<{ raw: string; schema: TblsSchema }> {
  const { stdout } = await run(options);
  return { raw: stdout, schema: parseTblsJson(stdout) };
}

export function parseTblsJson(text: string): TblsSchema {
  let schema: TblsSchema;
  try {
    schema = JSON.parse(text) as TblsSchema;
  } catch (err) {
    throw new TblsError(`不是合法的 JSON：${(err as Error).message}`);
  }
  if (!schema || !Array.isArray(schema.tables)) {
    throw new TblsError('缺少 tables 数组，不是 tbls 导出的 JSON');
  }
  return schema;
}

/**
 * `tbls out -t config` writes the plaintext DSN (with password) into the config.
 * Strips it, preserving comments, so the DSN can go to the credential store instead.
 */
export function stripDsnFromTblsConfig(text: string): { text: string; dsn?: string } {
  const doc = parseDocument(text);
  const dsn = doc.get('dsn');
  if (dsn === undefined || dsn === null) {
    return { text };
  }
  doc.delete('dsn');
  return { text: doc.toString({ lineWidth: 0 }), dsn: typeof dsn === 'string' ? dsn : String(dsn) };
}

function run(options: TblsOutOptions): Promise<{ stdout: string; stderr: string }> {
  const { tblsPath: file, cwd, dsn } = options;
  const args = ['out', '-t', 'json', '--sort'];
  if (options.configPath) args.push('-c', options.configPath);
  for (const pattern of options.include) args.push('--include', pattern);
  for (const pattern of options.exclude) args.push('--exclude', pattern);
  const mask = (text: string) => maskSecret(text, dsn, options.secrets);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, TBLS_DSN: dsn },
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        signal: options.signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === 'ENOENT') {
            reject(new TblsError(`找不到 tbls 可执行文件：${file}。请在设置 harness.tblsPath 中配置 tbls 的完整路径。`, 'notFound'));
          } else if (e.name === 'AbortError' || options.signal?.aborted) {
            reject(new TblsError('已取消', 'cancelled'));
          } else if (e.killed && options.timeoutMs) {
            reject(new TblsError(`tbls 在 ${Math.round(options.timeoutMs / 1000)} 秒内没有完成，已停止（可以在设置 harness.tblsTimeoutSeconds 中调整）`, 'timeout'));
          } else {
            reject(new TblsError(mask(stderr.trim() || err.message)));
          }
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function maskSecret(text: string, dsn?: string, extra: string[] = []): string {
  let masked = text;
  if (dsn) {
    masked = masked.split(dsn).join(maskDsn(dsn));
    const password = passwordOf(dsn);
    if (password) masked = masked.split(password).join('****');
  }
  for (const s of [...extra].sort((a, b) => b.length - a.length)) {
    if (s) masked = masked.split(s).join('****');
  }
  return masked;
}

export function maskDsn(dsn: string): string {
  const password = passwordOf(dsn);
  return password ? dsn.replace(`:${password}@`, ':****@') : dsn;
}

function passwordOf(dsn: string): string | undefined {
  const match = /^[a-z0-9+]+:\/\/[^:/@]+:([^@]+)@/i.exec(dsn);
  return match?.[1];
}
