import type { TblsResolveError, TblsResolveReason } from '../tbls/resolver';

export interface FriendlyError {
  message: string;
  /** The original (already masked) tbls output, shown under "详细信息". */
  detail?: string;
  action?: 'setTblsPath' | 'downloadTbls' | 'testTbls';
}

const RULES: { match: RegExp; message: string }[] = [
  {
    match: /password authentication failed|Access denied for user|Login failed|authentication failed|Authentication failed/i,
    message: '用户名或密码错误。MySQL 还可能是这个账号不允许从当前机器登录。',
  },
  { match: /pg_hba\.conf/i, message: '服务器拒绝了这个地址或这种加密方式的连接，请联系数据库管理员。' },
  { match: /no such host|server misbehaving|getaddrinfo|Name or service not known/i, message: '找不到这个主机，请检查主机地址。' },
  {
    match: /connection refused|actively refused/i,
    message: '主机能访问，但端口没有开放。请检查端口，以及数据库是否已经启动。',
  },
  { match: /timeout|timed out|deadline exceeded/i, message: '连接超时。请检查网络、防火墙和数据库的访问白名单。' },
  {
    match: /SSL is not enabled|server does not support SSL|TLS requested but server does not support TLS/i,
    message: '服务器没有开启加密连接，请把加密选项改为不加密。',
  },
  { match: /does not exist|Unknown database|Cannot open database/i, message: '数据库不存在，请检查库名。' },
  { match: /unsupported driver/i, message: 'tbls 不支持这种连接串，请检查开头的数据库类型（scheme）。' },
];

/** `raw` must already be masked. */
export function friendlyTblsError(raw: string, reason?: 'notFound' | 'timeout' | 'cancelled'): FriendlyError {
  if (reason === 'notFound') return { message: raw, action: 'setTblsPath' };
  if (reason === 'cancelled') return { message: '已取消' };
  if (reason === 'timeout') return { message: raw };
  const rule = RULES.find((r) => r.match.test(raw));
  return rule ? { message: rule.message, detail: raw } : { message: raw };
}

/** Fallback copy when a resolve error somehow carries no message. */
const MISSING_REASON_TEXT: Record<TblsResolveReason, string> = {
  'missing-bundled': 'Harness 还没有内置的 tbls。可以点“下载内置 tbls”，或指定一个本地的 tbls。',
  'download-failed': 'Harness 内置的 tbls 下载失败。',
  'bad-path': 'harness.tblsPath 指向的文件不存在，请重新选择。',
  'not-on-path': 'PATH 里找不到这个 tbls，请指定完整路径。',
  'not-executable': '这个 tbls 无法运行，请换一个文件。',
};

/**
 * Turns a resolve failure into actionable copy plus the button that fixes it.
 *
 * `bad-path` / `not-on-path` / `not-executable` all mean "the configured binary is wrong" →
 * `setTblsPath`. `missing-bundled` / `download-failed` mean "we should fetch ours" →
 * `downloadTbls`.
 */
export function friendlyMissingTblsError(error: TblsResolveError): FriendlyError {
  const text = error.message && error.message !== error.reason ? error.message : MISSING_REASON_TEXT[error.reason];
  switch (error.reason) {
    case 'download-failed':
      return { message: `Harness 内置的 tbls 下载失败：${text}`, detail: error.stack, action: 'downloadTbls' };
    case 'missing-bundled':
      return { message: text, action: 'downloadTbls' };
    default:
      return { message: text, action: 'setTblsPath' };
  }
}
