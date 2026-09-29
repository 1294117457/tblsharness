import type { DiagramHostMessage, DiagramWebviewMessage } from '@shared/diagramProtocol';
import { postRaw } from '../vscode';

type Reply = { ok: boolean; error?: string; message?: string };
type RequestMessage = Extract<DiagramWebviewMessage, { requestId: string }>;
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never;

let nextId = 0;
const pending = new Map<string, (reply: Reply) => void>();
let handler: ((msg: DiagramHostMessage) => void) | undefined;

window.addEventListener('message', (event: MessageEvent<DiagramHostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'reply') {
    const resolve = pending.get(msg.requestId);
    pending.delete(msg.requestId);
    resolve?.({ ok: msg.ok, error: msg.error, message: msg.message });
    return;
  }
  handler?.(msg);
});

export function onMessage(fn: (msg: DiagramHostMessage) => void): void {
  handler = fn;
  send({ type: 'ready' });
}

export function send(message: Exclude<DiagramWebviewMessage, { requestId: string }>): void {
  postRaw(message);
}

export function request(message: WithoutRequestId<RequestMessage>): Promise<Reply> {
  const requestId = `d${++nextId}`;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    postRaw({ ...message, requestId });
  });
}
