import { driverInfo, parseParams, type ConnectionDriver, type ConnectionProfile } from '@shared/connection';

/** Everything the page edits. Lives only in component state: never in `setState`, which is persisted to disk. */
export interface ConnectionForm {
  driver: ConnectionDriver;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  file: string;
  dsn: string;
  security: string;
  schema: string;
  params: string;
  exclude: string;
  include: string;
}

export function toProfile(form: ConnectionForm): ConnectionProfile {
  const info = driverInfo(form.driver);
  const has = (f: (typeof info.fields)[number]) => info.fields.includes(f);
  const port = form.port.trim();
  const params = parseParams(form.params);
  return {
    version: 1,
    driver: form.driver,
    host: has('host') ? form.host.trim() : undefined,
    port: has('port') && port ? Number(port) : undefined,
    database: has('database') ? form.database.trim() : undefined,
    user: has('user') ? form.user.trim() : undefined,
    password: has('password') ? form.password : undefined,
    file: has('file') ? form.file.trim() : undefined,
    dsn: has('dsn') ? form.dsn.trim() : undefined,
    security: info.security ? form.security : undefined,
    params: form.driver !== 'custom' && form.driver !== 'sqlite' && Object.keys(params).length ? params : undefined,
  };
}

export function lines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
