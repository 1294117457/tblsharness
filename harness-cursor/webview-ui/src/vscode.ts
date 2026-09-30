import type { HostMessage, WebviewMessage } from '@shared/protocol';

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const inVsCode = typeof acquireVsCodeApi === 'function';

// acquireVsCodeApi throws when called twice, which happens whenever HMR re-executes this module.
const g = globalThis as { __harnessVsCodeApi?: VsCodeApi };
const api: VsCodeApi = (g.__harnessVsCodeApi ??= inVsCode ? acquireVsCodeApi() : createBrowserApi());

function createBrowserApi(): VsCodeApi {
  let state: unknown;
  return {
    postMessage: (m) => window.dispatchEvent(new CustomEvent('harness:to-host', { detail: m })),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
  };
}

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

/** For views with their own protocol (the connection and edit pages). */
export function postRaw(message: unknown): void {
  api.postMessage(message);
}

export function onHostMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>) => handler(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

let nextId = 0;
const pending = new Map<string, { resolve: (message?: string) => void; reject: (err: Error) => void }>();

type RequestMessage = Extract<WebviewMessage, { requestId: string }>;
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never;

/** Sends a message carrying a requestId and resolves with the host's optional summary when it replies. */
export function request(message: WithoutRequestId<RequestMessage>): Promise<string | undefined> {
  const requestId = `r${++nextId}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    post({ ...message, requestId } as unknown as WebviewMessage);
  });
}

export function settleReply(requestId: string, ok: boolean, error?: string, message?: string): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  if (ok) p.resolve(message);
  else p.reject(new Error(error ?? '操作失败'));
}

export function getState<T>(): T | undefined {
  return api.getState() as T | undefined;
}

export function setState<T>(state: T): void {
  api.setState(state);
}
