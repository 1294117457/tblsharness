import type { ConnectionHostMessage, ConnectionInit, ConnectionResult, ConnectionWebviewMessage } from '@shared/connectionProtocol';
import { postRaw } from '../vscode';

type Picked = Extract<ConnectionHostMessage, { type: 'filePicked' }>;
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never;
type RequestMessage = Extract<ConnectionWebviewMessage, { requestId: string }>;

let nextId = 0;
const pending = new Map<string, (msg: ConnectionHostMessage) => void>();
let initHandler: ((init: ConnectionInit) => void) | undefined;

window.addEventListener('message', (event: MessageEvent<ConnectionHostMessage>) => {
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
    resolve(msg);
  }
});

export function send(message: Exclude<ConnectionWebviewMessage, RequestMessage>): void {
  postRaw(message);
}

export function onInit(handler: (init: ConnectionInit) => void): void {
  initHandler = handler;
  send({ type: 'ready' });
}

function request(message: WithoutRequestId<RequestMessage>): Promise<ConnectionHostMessage> {
  const requestId = `c${++nextId}`;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    postRaw({ ...message, requestId });
  });
}

export async function run(message: WithoutRequestId<Extract<RequestMessage, { type: 'test' | 'connect' | 'importFile' }>>): Promise<ConnectionResult> {
  const reply = await request(message);
  if (reply.type !== 'result') return { ok: false, message: '插件返回了意外的结果' };
  const { type: _type, requestId: _id, ...result } = reply;
  return result as ConnectionResult;
}

export async function pickFile(purpose: 'sqlite' | 'json'): Promise<Omit<Picked, 'type' | 'requestId'>> {
  const reply = await request({ type: 'pickFile', purpose });
  if (reply.type !== 'filePicked') return {};
  const { type: _type, requestId: _id, ...rest } = reply;
  return rest;
}
