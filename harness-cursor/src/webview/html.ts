import * as vscode from 'vscode';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  context: vscode.ExtensionContext;
  title: string;
  /** Which app `main.ts` mounts. */
  view?: 'canvas' | 'connection' | 'edit' | 'diagram';
}

export function webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
  };
}

export function renderWebviewHtml(opts: WebviewHtmlOptions): string {
  const devUrl = devServerUrl(opts.context);
  return devUrl ? renderDevHtml(opts, devUrl) : renderProdHtml(opts);
}

/** Only an F5 extension-development host with HARNESS_WEBVIEW_DEV_URL set ever talks to a local dev server. */
function devServerUrl(context: vscode.ExtensionContext): string | undefined {
  if (context.extensionMode !== vscode.ExtensionMode.Development) {
    return undefined;
  }
  const url = process.env.HARNESS_WEBVIEW_DEV_URL?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

function renderProdHtml({ webview, context, title, view = 'canvas' }: WebviewHtmlOptions): string {
  const base = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.css'));
  const nonce = createNonce();
  // Vue Flow positions nodes with inline styles, so style-src needs 'unsafe-inline'.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `worker-src ${webview.cspSource} blob:`,
  ].join('; ');
  return page(csp, title, view, `<link rel="stylesheet" href="${style}" />`, `<script type="module" nonce="${nonce}" src="${script}"></script>`);
}

function renderDevHtml({ webview, title, view = 'canvas' }: WebviewHtmlOptions, devUrl: string): string {
  const nonce = createNonce();
  const wsUrl = devUrl.replace(/^http/, 'ws');
  // Modules imported by the nonce'd entry are checked against the host allow-list, so devUrl must be in script-src.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} ${devUrl} data:`,
    `style-src ${webview.cspSource} ${devUrl} 'unsafe-inline'`,
    `font-src ${webview.cspSource} ${devUrl}`,
    `script-src 'nonce-${nonce}' ${devUrl}`,
    `connect-src ${devUrl} ${wsUrl}`,
    `worker-src ${devUrl} blob:`,
  ].join('; ');
  return page(
    csp,
    title,
    view,
    '',
    `<script type="module" nonce="${nonce}" src="${devUrl}/@vite/client"></script>
  <script type="module" nonce="${nonce}" src="${devUrl}/src/main.ts"></script>`,
  );
}

function page(csp: string, title: string, view: string, head: string, scripts: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${head}
  <title>${escapeHtml(title)}</title>
</head>
<body data-view="${view}">
  <div id="app"></div>
  ${scripts}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
