/**
 * Stand-in for the extension host of the edit page in a normal browser (`?view=edit&kind=design|workspace|canvas`).
 */
import type { EditHostMessage, EditKind, EditWebviewMessage } from '@shared/editProtocol';
import { DESIGN_DRIVERS } from '@shared/workspace';

function send(msg: EditHostMessage) {
  setTimeout(() => window.postMessage(msg, '*'), 30);
}

function handle(msg: EditWebviewMessage) {
  switch (msg.type) {
    case 'ready': {
      const param = new URLSearchParams(location.search).get('kind');
      const kind: EditKind = param === 'workspace' || param === 'canvas' ? param : 'design';
      const names: Record<EditKind, string> = { workspace: '演示工作区', design: '设计库 1', canvas: '画布 1' };
      send({
        type: 'init',
        kind,
        workspaceName: '演示工作区',
        name: names[kind],
        ...(kind === 'design' ? { driver: 'postgres', drivers: DESIGN_DRIVERS, tableCount: 12 } : {}),
      });
      return;
    }
    case 'save':
      console.info('[mock edit host] 保存', msg);
      send(msg.name.trim() === 'fail' ? { type: 'result', requestId: msg.requestId, ok: false, message: '模拟保存失败' } : { type: 'result', requestId: msg.requestId, ok: true });
      return;
    default:
      console.info('[mock edit host]', msg);
  }
}

export function installMockEditHost(): void {
  window.addEventListener('harness:to-host', (e) => handle((e as CustomEvent<EditWebviewMessage>).detail));
  console.info('[mock edit host] 已启用浏览器模拟宿主');
}
