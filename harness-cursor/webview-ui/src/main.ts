import { createApp, type Component } from 'vue';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import './style.css';
import { inVsCode } from './vscode';

type View = 'canvas' | 'connection' | 'edit' | 'diagram';

const VIEWS: View[] = ['canvas', 'connection', 'edit', 'diagram'];

/** The host writes `data-view` on <body>; in the browser dev server use `?view=connection`, `?view=edit` or `?view=diagram`. */
function currentView(): View {
  const view = document.body.dataset.view ?? new URLSearchParams(location.search).get('view');
  return VIEWS.includes(view as View) ? (view as View) : 'canvas';
}

async function boot() {
  const view = currentView();
  if (import.meta.env.DEV && !inVsCode) {
    if (view === 'connection') (await import('./dev/mockConnectionHost')).installMockConnectionHost();
    else if (view === 'edit') (await import('./dev/mockEditHost')).installMockEditHost();
    else if (view === 'diagram') (await import('./dev/mockDiagramHost')).installMockDiagramHost();
    else (await import('./dev/mockHost')).installMockHost();
  }
  const apps: Record<View, () => Promise<{ default: Component }>> = {
    canvas: () => import('./App.vue'),
    connection: () => import('./connection/ConnectionApp.vue'),
    edit: () => import('./edit/EditApp.vue'),
    diagram: () => import('./diagram/DiagramApp.vue'),
  };
  createApp((await apps[view]()).default).mount('#app');
}

void boot();
