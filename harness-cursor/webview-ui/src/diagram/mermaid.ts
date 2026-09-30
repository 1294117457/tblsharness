type Mermaid = typeof import('mermaid').default;

let mermaid: Promise<Mermaid> | undefined;

function isDark(): boolean {
  const cls = document.body.classList;
  return !cls.contains('vscode-light') && !cls.contains('vscode-high-contrast-light');
}

/** Loaded on first use and shared by every preview: mermaid is large. */
export function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default', er: { useMaxWidth: false } });
    return m.default;
  });
  return mermaid;
}

export function shortError(err: unknown): string {
  return (err as Error).message?.split('\n').slice(0, 4).join('\n') || String(err);
}

/** Syntax error of a Mermaid text, or `undefined` when it parses (or is empty). */
export async function mermaidError(code: string): Promise<string | undefined> {
  if (!code.trim()) return undefined;
  try {
    await (await loadMermaid()).parse(code);
    return undefined;
  } catch (err) {
    return shortError(err);
  }
}
