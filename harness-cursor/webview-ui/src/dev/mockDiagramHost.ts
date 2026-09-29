/**
 * Stand-in for the extension host of the diagram editor in a normal browser (`?view=diagram`).
 * Sync results are canned; the real comparison runs in the extension host.
 */
import type { DiagramHostMessage, DiagramWebviewMessage } from '@shared/diagramProtocol';
import type { SyncGroup } from '@shared/sync';

const CODE = `erDiagram
  users["用户"] {
    bigint id PK "主键"
    varchar(128) email UK "登录邮箱"
  }
  orders["订单"] {
    bigint id PK
    bigint user_id FK "下单人"
    numeric(10,2) amount "金额"
  }
  refunds["退款"] {
    bigint id PK
    bigint order_id FK
  }
  users ||--o{ orders : "user_id"
  orders ||--o{ refunds : "order_id"`;

const group: SyncGroup = {
  workspace: 'workspace1',
  design: 'design1',
  designName: '设计库 1',
  diagram: 'diagram1',
  diagramName: '订单核心',
  result: {
    ignored: 1,
    problems: [],
    items: [
      { id: 'table.add:refunds', action: 'add', target: 'table', table: 'refunds', message: '新建表 refunds（退款）', detail: '字段：id, order_id', defaultChecked: true, ops: [], order: 0 },
      { id: 'column.type:users.email', action: 'change', target: 'column', table: 'users', column: 'email', message: '字段 users.email 类型 varchar(64) → varchar(128)', defaultChecked: true, ops: [], order: 3 },
      {
        id: 'relation.add:refunds->orders(order_id)',
        action: 'add',
        target: 'relation',
        table: 'refunds',
        message: '新增关系 refunds.order_id → orders（fk）',
        defaultChecked: true,
        requires: ['table.add:refunds'],
        ops: [],
        order: 4,
      },
      { id: 'column.delete:orders.remark', action: 'delete', target: 'column', table: 'orders', column: 'remark', message: '删除字段 orders.remark', detail: '图里这张表没有写这个字段。', defaultChecked: false, ops: [], order: 6 },
    ],
  },
};

function send(msg: DiagramHostMessage) {
  setTimeout(() => window.postMessage(msg, '*'), 30);
}

function handle(msg: DiagramWebviewMessage) {
  switch (msg.type) {
    case 'ready':
      send({
        type: 'init',
        doc: { meta: { type: 'er', name: '订单核心', refs: ['users', 'orders'], ignored: [] }, code: CODE, problems: [] },
        context: { designName: '设计库 1', driver: 'PostgreSQL', tableCount: 12 },
      });
      send({ type: 'sync', group });
      return;
    case 'sync/apply':
      console.info('[mock diagram host] 同步', msg);
      send({ type: 'reply', requestId: msg.requestId, ok: true, message: `已同步 ${msg.ids.length} 项到表结构` });
      send({ type: 'sync', group: { ...group, result: { ...group.result, items: [] } }, undo: `从设计图“订单核心”同步 ${msg.ids.length} 项` });
      return;
    case 'sync/ignore':
    case 'sync/undo':
    case 'regenerate':
      send({ type: 'reply', requestId: msg.requestId, ok: true });
      if (msg.type === 'sync/undo') send({ type: 'sync', group });
      return;
    default:
      console.info('[mock diagram host]', msg);
  }
}

export function installMockDiagramHost(): void {
  window.addEventListener('harness:to-host', (e) => handle((e as CustomEvent<DiagramWebviewMessage>).detail));
  console.info('[mock diagram host] 已启用浏览器模拟宿主');
}
