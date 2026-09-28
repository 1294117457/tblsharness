/**
 * Connection profiles for the "添加数据库" page. Pure functions only: shared by the extension host,
 * the webview and the tests. A profile is only ever persisted in the OS credential store.
 */

export type ConnectionDriver = 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite' | 'clickhouse' | 'redshift' | 'custom';

export type ConnectionField = 'host' | 'port' | 'database' | 'user' | 'password' | 'file' | 'dsn';

export interface ConnectionProfile {
  version: 1;
  driver: ConnectionDriver;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** SQLite database file */
  file?: string;
  /** sslmode / tls / encrypt; values depend on the driver */
  security?: string;
  /** Extra `key=value` query parameters, appended as-is after ours */
  params?: Record<string, string>;
  /** The whole DSN when driver is custom */
  dsn?: string;
}

export interface SecurityOption {
  value: string;
  label: string;
}

export interface DriverInfo {
  id: ConnectionDriver;
  label: string;
  scheme?: string;
  defaultPort?: number;
  fields: ConnectionField[];
  security?: { label: string; options: SecurityOption[]; local: string; remote: string };
  /** Shown under the form when the driver is selected */
  note?: string;
  /** Default schema placeholder in advanced options */
  schemaHint?: string;
}

const PG_SECURITY: DriverInfo['security'] = {
  label: 'SSL',
  options: [
    { value: 'disable', label: 'disable（不加密）' },
    { value: 'require', label: 'require（加密，不校验证书）' },
    { value: 'verify-ca', label: 'verify-ca（校验 CA）' },
    { value: 'verify-full', label: 'verify-full（校验 CA 和主机名）' },
  ],
  local: 'disable',
  remote: 'require',
};

const MYSQL_SECURITY: DriverInfo['security'] = {
  label: 'TLS',
  options: [
    { value: 'false', label: 'false（不加密）' },
    { value: 'preferred', label: 'preferred（服务器支持时加密）' },
    { value: 'skip-verify', label: 'skip-verify（加密，不校验证书）' },
    { value: 'true', label: 'true（加密并校验证书）' },
  ],
  local: 'false',
  remote: 'preferred',
};

const SERVER_FIELDS: ConnectionField[] = ['host', 'port', 'database', 'user', 'password'];

export const CONNECTION_DRIVERS: DriverInfo[] = [
  { id: 'postgres', label: 'PostgreSQL', scheme: 'postgres', defaultPort: 5432, fields: SERVER_FIELDS, security: PG_SECURITY, schemaHint: 'public' },
  { id: 'mysql', label: 'MySQL', scheme: 'mysql', defaultPort: 3306, fields: SERVER_FIELDS, security: MYSQL_SECURITY },
  { id: 'mariadb', label: 'MariaDB', scheme: 'mariadb', defaultPort: 3306, fields: SERVER_FIELDS, security: MYSQL_SECURITY },
  {
    id: 'sqlserver',
    label: 'SQL Server',
    scheme: 'sqlserver',
    defaultPort: 1433,
    fields: SERVER_FIELDS,
    security: {
      label: '加密',
      options: [
        { value: 'disable', label: '不加密' },
        { value: 'true', label: '加密并校验证书' },
        { value: 'trust', label: '加密，信任服务器证书' },
      ],
      local: 'disable',
      remote: 'true',
    },
    note: 'tbls 要求 SQL Server 2017 或以上版本，数据库兼容级别 110 以上。',
    schemaHint: 'dbo',
  },
  { id: 'sqlite', label: 'SQLite', scheme: 'sqlite', fields: ['file'], note: '以只读方式打开数据库文件。' },
  { id: 'clickhouse', label: 'ClickHouse', scheme: 'clickhouse', defaultPort: 9000, fields: SERVER_FIELDS },
  { id: 'redshift', label: 'Amazon Redshift', scheme: 'redshift', defaultPort: 5439, fields: SERVER_FIELDS, security: PG_SECURITY, schemaHint: 'public' },
  {
    id: 'custom',
    label: '其他（自定义连接串）',
    fields: ['dsn'],
    note: '用于 BigQuery、Cloud Spanner、Snowflake、Databricks、MongoDB、DynamoDB、Azure SQL 等。整条连接串按密码对待，只保存在系统凭据中。',
  },
];

export const CUSTOM_DSN_EXAMPLES: { label: string; example: string }[] = [
  { label: 'BigQuery', example: 'bigquery://project-id/dataset-id?creds=/path/to/google_application_credentials.json' },
  { label: 'Cloud Spanner', example: 'spanner://project-id/instance-id/db-name?creds=/path/to/google_application_credentials.json' },
  { label: 'Snowflake', example: 'snowflake://user:password@account/db-name/schema-name?warehouse=warehouse-name' },
  { label: 'MongoDB', example: 'mongodb://user:password@hostname:27017/db-name?sampleSize=20' },
  { label: 'DynamoDB', example: 'dynamodb://ap-northeast-1' },
  { label: 'Databricks', example: 'databricks://token:access-token@host:443/http-path?catalog=main' },
];

export const TBLS_DSN_DOC_URL = 'https://github.com/k1LoW/tbls#database-connection';

export function driverInfo(driver: ConnectionDriver): DriverInfo {
  return CONNECTION_DRIVERS.find((d) => d.id === driver) ?? CONNECTION_DRIVERS[CONNECTION_DRIVERS.length - 1];
}

export function defaultPort(driver: ConnectionDriver): number | undefined {
  return driverInfo(driver).defaultPort;
}

export function isLocalHost(host: string | undefined): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Encryption default for a host, per driver: off for this machine, on for anything else. */
export function defaultSecurity(driver: ConnectionDriver, host: string | undefined): string | undefined {
  const s = driverInfo(driver).security;
  if (!s) return undefined;
  return isLocalHost(host) || !(host ?? '').trim() ? s.local : s.remote;
}

const CONNECT_TIMEOUT_SECONDS = 10;

/** Builds the tbls DSN. User name, password and database are percent-encoded, so raw values can be typed in. */
export function buildDsn(profile: ConnectionProfile): string {
  const info = driverInfo(profile.driver);
  if (profile.driver === 'custom' || !info.scheme) {
    return (profile.dsn ?? '').trim();
  }
  if (profile.driver === 'sqlite') {
    return `sqlite://${sqlitePath(profile.file ?? '')}?mode=ro`;
  }

  const user = (profile.user ?? '').trim();
  const auth = user ? `${encodeURIComponent(user)}${profile.password ? `:${encodeURIComponent(profile.password)}` : ''}@` : '';
  const port = profile.port ?? info.defaultPort;
  const hostPort = `${formatHost((profile.host ?? '').trim())}${port ? `:${port}` : ''}`;
  const database = (profile.database ?? '').trim();
  const path = database ? `/${encodeURIComponent(database)}` : '';

  const query: [string, string][] = [];
  const security = profile.security ?? defaultSecurity(profile.driver, profile.host);
  query.push(...securityParams(profile.driver, security));
  query.push(...timeoutParams(profile.driver));
  const extra = Object.entries(profile.params ?? {}).filter(([k]) => k.trim());
  const overridden = new Set(extra.map(([k]) => k.trim()));
  const params = [...query.filter(([k]) => !overridden.has(k)), ...extra.map(([k, v]) => [k.trim(), v] as [string, string])];
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  return `${info.scheme}://${auth}${hostPort}${path}${qs ? `?${qs}` : ''}`;
}

function formatHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

/** `C:\data\my app.db` → `/C:/data/my%20app.db` (checked against tbls 1.96 on Windows). */
function sqlitePath(file: string): string {
  const segments = file.trim().replace(/\\/g, '/').split('/');
  const encoded = segments.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
  return encoded.startsWith('/') ? encoded : `/${encoded}`;
}

function securityParams(driver: ConnectionDriver, security: string | undefined): [string, string][] {
  if (!security) return [];
  switch (driver) {
    case 'postgres':
    case 'redshift':
      return [['sslmode', security]];
    case 'mysql':
    case 'mariadb':
      return [['tls', security]];
    case 'sqlserver':
      return security === 'trust'
        ? [
            ['encrypt', 'true'],
            ['TrustServerCertificate', 'true'],
          ]
        : [['encrypt', security]];
    default:
      return [];
  }
}

function timeoutParams(driver: ConnectionDriver): [string, string][] {
  const s = CONNECT_TIMEOUT_SECONDS;
  switch (driver) {
    case 'postgres':
    case 'redshift':
      return [['connect_timeout', String(s)]];
    case 'mysql':
    case 'mariadb':
      return [['timeout', `${s}s`]];
    case 'sqlserver':
      return [['dial timeout', String(s)]];
    case 'clickhouse':
      return [['dial_timeout', `${s}s`]];
    default:
      return [];
  }
}

/** Field name → message; empty when the profile can be used. */
export function validateProfile(profile: ConnectionProfile, opts: { passwordOptional?: boolean } = {}): Partial<Record<ConnectionField, string>> {
  const errors: Partial<Record<ConnectionField, string>> = {};
  const info = driverInfo(profile.driver);
  const blank = (v: string | undefined) => !(v ?? '').trim();
  for (const field of info.fields) {
    switch (field) {
      case 'host':
        if (blank(profile.host)) errors.host = '请填写主机地址';
        else if (/[\s/?#@]/.test(profile.host!.trim())) errors.host = '主机地址不能包含空格、/、?、#、@';
        break;
      case 'port':
        if (profile.port !== undefined && (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535)) {
          errors.port = '端口必须是 1 到 65535 的整数';
        }
        break;
      case 'database':
        if (blank(profile.database)) errors.database = '请填写数据库名';
        break;
      case 'user':
        if (blank(profile.user)) errors.user = '请填写用户名';
        break;
      case 'password':
        break;
      case 'file':
        if (blank(profile.file)) errors.file = '请选择数据库文件';
        break;
      case 'dsn':
        if (blank(profile.dsn)) {
          if (!opts.passwordOptional) errors.dsn = '请填写连接串';
        } else if (!/^[a-z][a-z0-9+.-]*:/i.test(profile.dsn!.trim())) {
          errors.dsn = '连接串需要以 scheme: 开头，例如 bigquery:// 或 mongodb://';
        }
        break;
    }
  }
  return errors;
}

/** For display only: never contains the password. e.g. `reader@localhost:5432/orders` */
export function describeProfile(profile: ConnectionProfile): string {
  if (profile.driver === 'custom') return maskPassword(profile.dsn ?? '');
  if (profile.driver === 'sqlite') return profile.file ?? '';
  const port = profile.port ?? defaultPort(profile.driver);
  const user = profile.user ? `${profile.user}@` : '';
  return `${user}${formatHost(profile.host ?? '')}${port ? `:${port}` : ''}/${profile.database ?? ''}`;
}

/**
 * How a connected db source is shown: `host:port/db` (the port is always included), the file name for SQLite.
 * Contains the host, so it is computed on the fly and never written to a file or handed to the AI.
 */
export function connectionLabel(profile: ConnectionProfile): string | undefined {
  if (profile.driver === 'sqlite') return baseName(profile.file ?? '') || undefined;
  if (profile.driver === 'custom') return dsnLabel(profile.dsn ?? '');
  const host = (profile.host ?? '').trim();
  if (!host) return undefined;
  return hostLabel(host, profile.port ?? defaultPort(profile.driver), (profile.database ?? '').trim());
}

function hostLabel(host: string, port: number | undefined, database: string): string {
  return `${formatHost(host)}${port ? `:${port}` : ''}${database ? `/${database}` : ''}`;
}

function baseName(file: string): string {
  return file.trim().split(/[\\/]/).pop() ?? '';
}

/** Best effort for URL-style DSNs; undefined when there is nothing recognisable to show. */
function dsnLabel(dsn: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(dsn.trim());
  if (!m) return undefined;
  const [, scheme, authority, path, query] = m;
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const hp = /^(\[[^\]]+\]|[^:]*)(?::(\d+))?$/.exec(hostPort);
  const host = hp?.[1] ?? '';
  if (!host) return baseName(decodeSafe(path)) || undefined;
  const known = CONNECTION_DRIVERS.find((d) => d.scheme === scheme.toLowerCase());
  const port = hp?.[2] ? Number(hp[2]) : known?.defaultPort;
  const params = new URLSearchParams(query ?? '');
  const database = decodeSafe(path.replace(/^\/+/, '').split('/')[0] ?? '') || params.get('database') || params.get('dbname') || '';
  return hostLabel(host.replace(/^\[|\]$/g, ''), port, database);
}

/** Fallback name kept in source.yml, e.g. "PostgreSQL · orders". Deliberately without the host. */
export function defaultConnectionName(profile: ConnectionProfile): string {
  if (profile.driver === 'custom') {
    const dsn = (profile.dsn ?? '').trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(dsn)?.[1];
    if (!scheme) return '数据库';
    const withoutQuery = dsn.split('?')[0].replace(/\/+$/, '');
    const last = withoutQuery.slice(scheme.length + 1).replace(/^\/+/, '').split('/').pop() ?? '';
    const tail = last.includes('@') || last.includes(':') ? '' : decodeSafe(last);
    return tail ? `${scheme} · ${tail}` : scheme;
  }
  const label = driverInfo(profile.driver).label;
  if (profile.driver === 'sqlite') {
    const base = (profile.file ?? '').split(/[\\/]/).pop()?.trim();
    return base ? `${label} · ${base}` : label;
  }
  const db = (profile.database ?? '').trim();
  return db ? `${label} · ${db}` : label;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function maskPassword(dsn: string): string {
  return dsn.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@]+:)[^@]*@/i, '$1****@');
}

/**
 * Parses what is stored in the credential store. The first stage-2 build stored a bare DSN string;
 * anything that is not a JSON profile is treated as such.
 */
export function parseStoredConnection(stored: string): ConnectionProfile {
  const text = stored.trim();
  if (text.startsWith('{')) {
    try {
      const raw = JSON.parse(text) as Partial<ConnectionProfile>;
      if (raw && typeof raw.driver === 'string' && CONNECTION_DRIVERS.some((d) => d.id === raw.driver)) {
        return {
          version: 1,
          driver: raw.driver,
          host: str(raw.host),
          port: typeof raw.port === 'number' ? raw.port : undefined,
          database: str(raw.database),
          user: str(raw.user),
          password: str(raw.password),
          file: str(raw.file),
          security: str(raw.security),
          params: raw.params && typeof raw.params === 'object' ? Object.fromEntries(Object.entries(raw.params).map(([k, v]) => [k, String(v)])) : undefined,
          dsn: str(raw.dsn),
        };
      }
    } catch {
      // fall through: not ours
    }
  }
  return { version: 1, driver: 'custom', dsn: text };
}

export function serializeConnection(profile: ConnectionProfile): string {
  return JSON.stringify(profile);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The secret parts of a profile, for masking error output. Includes the percent-encoded forms that appear in DSNs. */
export function secretsOf(profile: ConnectionProfile): string[] {
  const out = new Set<string>();
  for (const s of [profile.password, profile.dsn && profile.driver === 'custom' ? profile.dsn : undefined]) {
    if (s) {
      out.add(s);
      out.add(encodeURIComponent(s));
    }
  }
  const dsn = buildDsn(profile);
  const pw = /^[a-z][a-z0-9+.-]*:\/\/[^:/@]+:([^@]+)@/i.exec(dsn)?.[1];
  if (pw) out.add(pw);
  return [...out].filter((s) => s.length >= 1).sort((a, b) => b.length - a.length);
}

export function maskWith(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('****');
  return out;
}

/** Parses the "附加参数" textarea: one `key=value` per line (or `&`-separated). */
export function parseParams(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[\n&]/)) {
    const line = part.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (key) out[key] = eq < 0 ? '' : line.slice(eq + 1).trim();
  }
  return out;
}

export function formatParams(params: Record<string, string> | undefined): string {
  return Object.entries(params ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}
