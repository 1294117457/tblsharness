import { describe, expect, it } from 'vitest';
import { friendlyTblsError } from '../src/connection/errors';
import {
  buildDsn,
  connectionLabel,
  defaultConnectionName,
  defaultSecurity,
  describeProfile,
  maskWith,
  parseParams,
  parseStoredConnection,
  secretsOf,
  serializeConnection,
  validateProfile,
  type ConnectionProfile,
} from '../src/shared/connection';

// Placeholder values only; never paste real connection details into tests.
const pg: ConnectionProfile = {
  version: 1,
  driver: 'postgres',
  host: 'db.example.test',
  port: 5432,
  database: 'orders',
  user: 'reader',
  password: 'example-secret',
  security: 'require',
};

describe('connectionLabel', () => {
  it('shows host:port/db and always includes the port', () => {
    expect(connectionLabel(pg)).toBe('db.example.test:5432/orders');
    expect(connectionLabel({ ...pg, port: undefined })).toBe('db.example.test:5432/orders');
    expect(connectionLabel({ version: 1, driver: 'mysql', host: '10.0.0.8', database: 'shop' })).toBe('10.0.0.8:3306/shop');
    expect(connectionLabel({ version: 1, driver: 'sqlserver', host: 'db.example.test', port: 11433 })).toBe('db.example.test:11433');
  });

  it('brackets IPv6 hosts and uses the file name for SQLite', () => {
    expect(connectionLabel({ ...pg, host: '::1' })).toBe('[::1]:5432/orders');
    expect(connectionLabel({ version: 1, driver: 'sqlite', file: 'C:\\data\\app.db' })).toBe('app.db');
  });

  it('parses URL-style custom DSNs without exposing credentials', () => {
    expect(connectionLabel({ version: 1, driver: 'custom', dsn: 'postgres://reader:example-secret@db.example.test/orders?sslmode=require' })).toBe(
      'db.example.test:5432/orders',
    );
    expect(connectionLabel({ version: 1, driver: 'custom', dsn: 'sqlserver://reader:x@db.example.test:1433?database=sales' })).toBe('db.example.test:1433/sales');
    expect(connectionLabel({ version: 1, driver: 'custom', dsn: 'sqlite:///C:/data/app.db' })).toBe('app.db');
    expect(connectionLabel({ version: 1, driver: 'custom', dsn: 'not a dsn' })).toBeUndefined();
  });

  it('is undefined when there is no host yet', () => {
    expect(connectionLabel({ ...pg, host: '' })).toBeUndefined();
  });
});

describe('buildDsn', () => {
  it('builds each driver with its security and timeout parameters', () => {
    expect(buildDsn(pg)).toBe('postgres://reader:example-secret@db.example.test:5432/orders?sslmode=require&connect_timeout=10');
    expect(buildDsn({ ...pg, driver: 'mysql', port: 3306, security: 'preferred' })).toBe(
      'mysql://reader:example-secret@db.example.test:3306/orders?tls=preferred&timeout=10s',
    );
    expect(buildDsn({ ...pg, driver: 'mariadb', port: undefined, security: 'false' })).toBe(
      'mariadb://reader:example-secret@db.example.test:3306/orders?tls=false&timeout=10s',
    );
    expect(buildDsn({ ...pg, driver: 'sqlserver', port: 1433, security: 'trust' })).toBe(
      'sqlserver://reader:example-secret@db.example.test:1433/orders?encrypt=true&TrustServerCertificate=true&dial%20timeout=10',
    );
    expect(buildDsn({ ...pg, driver: 'clickhouse', port: 9000, security: undefined })).toBe(
      'clickhouse://reader:example-secret@db.example.test:9000/orders?dial_timeout=10s',
    );
    expect(buildDsn({ ...pg, driver: 'redshift', port: undefined })).toBe(
      'redshift://reader:example-secret@db.example.test:5439/orders?sslmode=require&connect_timeout=10',
    );
  });

  it('percent-encodes user, password and database so raw values can be typed', () => {
    const dsn = buildDsn({ ...pg, user: 'rea der', password: 'p#ss@w%rd :/?', database: '订单' });
    expect(dsn).toBe(
      'postgres://rea%20der:p%23ss%40w%25rd%20%3A%2F%3F@db.example.test:5432/%E8%AE%A2%E5%8D%95?sslmode=require&connect_timeout=10',
    );
    expect(decodeURIComponent(new URL(dsn).password)).toBe('p#ss@w%rd :/?');
  });

  it('brackets IPv6 hosts', () => {
    expect(buildDsn({ ...pg, host: '::1', security: 'disable' })).toBe('postgres://reader:example-secret@[::1]:5432/orders?sslmode=disable&connect_timeout=10');
  });

  it('defaults encryption by host when not chosen', () => {
    expect(defaultSecurity('postgres', 'localhost')).toBe('disable');
    expect(defaultSecurity('postgres', 'db.example.test')).toBe('require');
    expect(defaultSecurity('mysql', '127.0.0.1')).toBe('false');
    expect(defaultSecurity('mysql', '10.0.0.5')).toBe('preferred');
    expect(buildDsn({ ...pg, host: 'localhost', security: undefined })).toContain('sslmode=disable');
  });

  it('appends extra parameters after ours, letting them override', () => {
    const dsn = buildDsn({ ...pg, params: { application_name: 'harness', connect_timeout: '30' } });
    expect(dsn).toBe('postgres://reader:example-secret@db.example.test:5432/orders?sslmode=require&application_name=harness&connect_timeout=30');
  });

  it('opens SQLite read-only with a Windows or POSIX path', () => {
    expect(buildDsn({ version: 1, driver: 'sqlite', file: 'C:\\data\\my app.db' })).toBe('sqlite:///C:/data/my%20app.db?mode=ro');
    expect(buildDsn({ version: 1, driver: 'sqlite', file: '/var/lib/app.db' })).toBe('sqlite:///var/lib/app.db?mode=ro');
  });

  it('passes custom DSNs through unchanged', () => {
    expect(buildDsn({ version: 1, driver: 'custom', dsn: '  bigquery://project/dataset  ' })).toBe('bigquery://project/dataset');
  });
});

describe('validateProfile', () => {
  it('requires the fields of the chosen driver', () => {
    expect(validateProfile(pg)).toEqual({});
    const errors = validateProfile({ version: 1, driver: 'postgres', host: '', database: '', user: '' });
    expect(Object.keys(errors).sort()).toEqual(['database', 'host', 'user']);
    expect(validateProfile({ version: 1, driver: 'mysql', host: 'a', database: 'b', user: 'c' })).toEqual({});
  });

  it('checks the port range', () => {
    expect(validateProfile({ ...pg, port: 0 }).port).toBeDefined();
    expect(validateProfile({ ...pg, port: 65536 }).port).toBeDefined();
    expect(validateProfile({ ...pg, port: 1.5 }).port).toBeDefined();
    expect(validateProfile({ ...pg, port: undefined }).port).toBeUndefined();
  });

  it('only asks SQLite for a file and custom for a DSN', () => {
    expect(validateProfile({ version: 1, driver: 'sqlite' })).toEqual({ file: '请选择数据库文件' });
    expect(validateProfile({ version: 1, driver: 'sqlite', file: 'a.db' })).toEqual({});
    expect(validateProfile({ version: 1, driver: 'custom' }).dsn).toBeDefined();
    expect(validateProfile({ version: 1, driver: 'custom' }, { passwordOptional: true })).toEqual({});
    expect(validateProfile({ version: 1, driver: 'custom', dsn: 'not a dsn' }).dsn).toBeDefined();
  });
});

describe('names and display', () => {
  it('builds the default name without the host', () => {
    expect(defaultConnectionName(pg)).toBe('PostgreSQL · orders');
    expect(defaultConnectionName(pg)).not.toContain('example.test');
    expect(defaultConnectionName({ version: 1, driver: 'mysql' })).toBe('MySQL');
    expect(defaultConnectionName({ version: 1, driver: 'sqlite', file: 'C:\\data\\app.db' })).toBe('SQLite · app.db');
    expect(defaultConnectionName({ version: 1, driver: 'custom', dsn: 'bigquery://project/dataset?creds=x' })).toBe('bigquery · dataset');
    expect(defaultConnectionName({ version: 1, driver: 'custom', dsn: 'mongodb://reader:example-secret@db.example.test:27017' })).toBe('mongodb');
  });

  it('describes a profile without the password', () => {
    expect(describeProfile(pg)).toBe('reader@db.example.test:5432/orders');
    expect(describeProfile({ version: 1, driver: 'custom', dsn: 'mongodb://reader:example-secret@db.example.test/app' })).not.toContain('example-secret');
  });
});

describe('stored connections', () => {
  it('round-trips a profile', () => {
    expect(parseStoredConnection(serializeConnection(pg))).toEqual({ ...pg, file: undefined, params: undefined, dsn: undefined });
  });

  it('treats a bare DSN from the first stage-2 build as custom', () => {
    const legacy = 'postgres://reader:example-secret@db.example.test:5432/app?sslmode=disable';
    expect(parseStoredConnection(legacy)).toEqual({ version: 1, driver: 'custom', dsn: legacy });
    expect(buildDsn(parseStoredConnection(legacy))).toBe(legacy);
  });

  it('treats JSON that is not a profile as a DSN', () => {
    expect(parseStoredConnection('{"foo":1}').driver).toBe('custom');
  });
});

describe('masking', () => {
  it('masks raw and encoded passwords', () => {
    const profile = { ...pg, password: 'p#ss@word' };
    const secrets = secretsOf(profile);
    const message = `failed ${buildDsn(profile)} password p#ss@word`;
    const masked = maskWith(message, secrets);
    expect(masked).not.toContain('p#ss@word');
    expect(masked).not.toContain('p%23ss%40word');
  });

  it('masks a whole custom DSN', () => {
    const profile: ConnectionProfile = { version: 1, driver: 'custom', dsn: 'snowflake://reader:example-secret@acct/db' };
    expect(maskWith(`bad ${profile.dsn}`, secretsOf(profile))).toBe('bad ****');
  });
});

describe('parseParams', () => {
  it('accepts lines or &-separated pairs', () => {
    expect(parseParams('a=1\n b = 2 \n\nc')).toEqual({ a: '1', b: '2', c: '' });
    expect(parseParams('a=1&b=x=y')).toEqual({ a: '1', b: 'x=y' });
  });
});

describe('friendlyTblsError', () => {
  it.each([
    ['pq: password authentication failed for user "reader"', '用户名或密码错误'],
    ["Error 1045 (28000): Access denied for user 'reader'@'10.0.0.1'", '用户名或密码错误'],
    ['dial tcp: lookup db.example.test on 10.0.0.1:53: no such host', '找不到这个主机'],
    ['dial tcp 10.0.0.1:1: connectex: No connection could be made because the target machine actively refused it.', '端口没有开放'],
    ['dial tcp 10.0.0.1:5432: connect: connection refused', '端口没有开放'],
    ['dial tcp 10.0.0.1:5432: i/o timeout', '连接超时'],
    ['pq: database "nope" does not exist', '数据库不存在'],
    ["Error 1049 (42000): Unknown database 'nope'", '数据库不存在'],
    ['pq: SSL is not enabled on the server', '没有开启加密'],
    ['pq: no pg_hba.conf entry for host "10.0.0.1", user "reader", database "orders", no encryption', '联系数据库管理员'],
  ])('%s', (raw, expected) => {
    const e = friendlyTblsError(raw);
    expect(e.message).toContain(expected);
    expect(e.detail).toBe(raw);
  });

  it('keeps unknown errors as they are', () => {
    expect(friendlyTblsError('something odd')).toEqual({ message: 'something odd' });
  });

  it('offers the tbls path setting when tbls is missing', () => {
    expect(friendlyTblsError('找不到 tbls', 'notFound').action).toBe('setTblsPath');
  });
});
