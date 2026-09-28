import type { EditHostMessage, EditInit, EditValues, EditWebviewMessage } from '@shared/editProtocol';
import { postRaw } from '../vscode';

type SaveResult = { ok: boolean; message?: string };

let nextId = 0;
const pending = new Map<string, (res: SaveResult) => void>();
let initHandler: ((init: EditInit) => void) | undefined;

window.addEventListener('message', (event: MessageEvent<EditHostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    const { type: _type, ...init } = msg;
    initHandler?.(init);
    return;
  }
  const resolve = pending.get(msg.requestId);
  if (resolve) {
    pending.delete(msg.requestId);
    resolve({ ok: msg.ok, message: msg.message });
  }
});

export function send(message: Exclude<EditWebviewMessage, { requestId: string }>): void {
  postRaw(message);
}

export function onInit(handler: (init: EditInit) => void): void {
  initHandler = handler;
  send({ type: 'ready' });
}

export function save(values: EditValues): Promise<SaveResult> {
  const requestId = `e${++nextId}`;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    postRaw({ type: 'save', requestId, ...values } satisfies EditWebviewMessage);
  });
}
