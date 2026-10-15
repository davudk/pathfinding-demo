import './style.css';
import { App, sceneFromUrl } from './app/app';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const params = new URLSearchParams(location.search);
try {
  const app = new App(
    { canvas: $('view'), hud: $('hud-rows'), graph: $('hud-graph'), selBox: $('selbox'), help: $('help') },
    sceneFromUrl(params),
    { main: params.get('sim') === 'main', forceTransfer: params.get('transport') === 'transfer' },
  );
  app.start().catch(fail);
  if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
} catch (err) {
  fail(err);
}

function fail(err: unknown): void {
  console.error(err);
  const box = $('fatal');
  box.textContent = err instanceof Error ? err.message : String(err);
  box.classList.remove('hidden');
}
