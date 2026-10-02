/**
 * Stand-in for the extension host of the connection page in a normal browser (`?view=connection`).
 * Fake results only: host `fail.example.test` fails, password `wrong` is rejected, anything else succeeds.
 */
import { buildDsn, connectionLabel, validateProfile, type ConnectionProfile } from '@shared/connection';
import type { ConnectionHostMessage, ConnectionResult, ConnectionWebviewMessage } from '@shared/connectionProtocol';

function send(msg: ConnectionHostMessage) {
  setTimeout(() => window.postMessage(msg, '*'), 30);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pendingId: string | undefined;

function fake(profile: ConnectionProfile): ConnectionResult {
  const errors = Object.values(validateProfile(profile));
  if (errors.length) return { ok: false, message: errors[0] };
  if (profile.host === 'fail.example.test') {
    return { ok: false, message: '找不到这个主机，请检查主机地址。', detail: 'dial tcp: lookup fail.example.test: no such host' };
  }
  if (profile.password === 'wrong') {
    return { ok: false, message: '用户名或密码错误。MySQL 还可能是这个账号不允许从当前机器登录。', detail: 'password authentication failed for user "reader"' };
  }
  return { ok: true, tables: 128, relations: 96, elapsedMs: 1200 };
}

function handle(msg: ConnectionWebviewMessage) {
  switch (msg.type) {
    case 'ready':
      send({
        type: 'init',
        mode: new URLSearchParams(location.search).get('mode') === 'edit' ? 'edit' : 'create',
        workspaceName: '演示工作区',
        driver: 'postgres',
        hasSavedPassword: false,
        filters: { exclude: ['pg_stat_statements', 'pgmq.*'], include: [] },
        tblsStatus: { source: 'bundled', bundledVersion: '1.86.0', installedVersion: '1.86.0', resolvedPath: 'C:\\Users\\demo\\.cursor\\extensions\\harness.harness\\globalStorage\\bin\\tbls.exe' },
      });
      return;
    case 'test':
    case 'connect': {
      console.info('[mock connection host] DSN =', buildDsn(msg.profile).replace(/:[^:@/]*@/, ':****@'));
      pendingId = msg.requestId;
      timer = setTimeout(() => {
        pendingId = undefined;
        send({ type: 'result', requestId: msg.requestId, ...fake(msg.profile) });
        if (msg.type === 'connect') console.info('[mock connection host] 已创建数据源：', connectionLabel(msg.profile));
      }, 1200);
      return;
    }
    case 'cancel':
      clearTimeout(timer);
      if (pendingId) send({ type: 'result', requestId: pendingId, ok: false, message: '已取消' });
      pendingId = undefined;
      return;
    case 'pickFile':
      send(
        msg.purpose === 'sqlite'
          ? { type: 'filePicked', requestId: msg.requestId, path: 'C:\\data\\app.db' }
          : { type: 'filePicked', requestId: msg.requestId, path: 'C:\\exports\\shop.json', name: 'shop', tables: 42 },
      );
      return;
    case 'pickTblsPath':
      send({ type: 'tblsPathPicked', requestId: msg.requestId, path: 'C:\\Program Files\\tbls\\tbls.exe' });
      return;
    case 'testTbls':
      send({ type: 'tblsTested', requestId: msg.requestId, ok: true, version: 'tbls version 1.6.0' });
      return;
    case 'installTbls':
      send({ type: 'tblsInstalled', requestId: msg.requestId, ok: true, path: 'C:\\Users\\demo\\.cursor\\extensions\\globalStorage\\bin\\tbls.exe' });
      return;
    case 'importFile':
      send({ type: 'result', requestId: msg.requestId, ok: true, tables: 42, relations: 30, elapsedMs: 0 });
      return;
    default:
      console.info('[mock connection host]', msg);
  }
}

export function installMockConnectionHost(): void {
  window.addEventListener('harness:to-host', (e) => handle((e as CustomEvent<ConnectionWebviewMessage>).detail));
  console.info('[mock connection host] 已启用浏览器模拟宿主');
}
