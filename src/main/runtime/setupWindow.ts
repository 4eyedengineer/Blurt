import { BrowserWindow } from 'electron'
import type { SetupStepDef } from './firstRunSetup'

/**
 * The packaged app's first-run setup screen: a small, blocking window shown
 * only when no healthy runtime venv is found (see `venvResolver.ts` /
 * `firstRunSetup.ts`) - a step list (matching `SETUP_STEPS`) plus a live
 * scrolling log tail, and a hard-error state if no Python 3.10+ interpreter
 * can be found.
 *
 * Deliberately self-contained: the whole page is a single static HTML
 * string loaded via a `data:` URL (no separate .html file to ship/build,
 * no preload script, no IPC channel) - main process pushes updates
 * directly via `webContents.executeJavaScript`, since this window's entire
 * content and lifecycle is owned by main and never touches anything
 * user-supplied or remote. Kept deliberately lean (see project philosophy:
 * "lean UI") - this is a one-time bootstrap screen, not part of the app's
 * regular UI.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderHtml(steps: SetupStepDef[]): string {
  const stepItems = steps
    .map(
      (step) =>
        `<li id="step-${step.id}" data-state="pending"><span class="mark"></span><span class="label">${escapeHtml(step.label)}</span></li>`
    )
    .join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Blurt - First-run setup</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    background: #111318; color: #e6e8ec;
    font-family: -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
  }
  h1 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  p.sub { margin: 0 0 16px; color: #9aa1ac; }
  ul#steps { list-style: none; margin: 0 0 16px; padding: 0; }
  ul#steps li {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0; color: #9aa1ac;
  }
  ul#steps li .mark {
    width: 14px; height: 14px; border-radius: 50%;
    border: 1.5px solid #4a5160; flex: 0 0 auto;
  }
  ul#steps li[data-state="active"] { color: #e6e8ec; }
  ul#steps li[data-state="active"] .mark { border-color: #5b9dff; background: #5b9dff44; }
  ul#steps li[data-state="done"] { color: #e6e8ec; }
  ul#steps li[data-state="done"] .mark { border-color: #3ecf6a; background: #3ecf6a; }
  ul#steps li[data-state="error"] .mark { border-color: #ef5350; background: #ef5350; }
  #log {
    background: #0a0b0e; border: 1px solid #23262e; border-radius: 6px;
    padding: 10px; height: 220px; overflow-y: auto;
    font-family: "Cascadia Mono", Consolas, monospace; font-size: 11.5px;
    line-height: 1.5; color: #9aa1ac; white-space: pre-wrap;
  }
  #error {
    display: none; margin-top: 16px; padding: 12px;
    border: 1px solid #ef5350; border-radius: 6px;
    background: #ef535022; color: #ffb4b0;
  }
  #error.visible { display: block; }
</style>
</head>
<body>
  <h1>Setting up Blurt</h1>
  <p class="sub">One-time setup - creating a local Python environment for offline speech recognition.</p>
  <ul id="steps">${stepItems}</ul>
  <div id="log"></div>
  <div id="error"></div>
  <script>
    window.__setStep = function (id, state) {
      var el = document.getElementById('step-' + id);
      if (el) el.setAttribute('data-state', state);
    };
    window.__appendLog = function (line) {
      var log = document.getElementById('log');
      var row = document.createElement('div');
      row.textContent = line;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    };
    window.__showFatalError = function (message) {
      var box = document.getElementById('error');
      box.textContent = message + ' (Close this window to quit.)';
      box.classList.add('visible');
    };
  </script>
</body>
</html>`
}

export class SetupWindow {
  private readonly window: BrowserWindow
  private readonly ready: Promise<void>

  constructor(steps: SetupStepDef[]) {
    this.window = new BrowserWindow({
      width: 560,
      height: 480,
      resizable: false,
      autoHideMenuBar: true,
      backgroundColor: '#111318',
      title: 'Blurt - First-run setup',
      webPreferences: { sandbox: false }
    })
    const html = renderHtml(steps)
    this.ready = this.window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => undefined)
  }

  /** Fires when the user closes the window (only meaningful on the hard-error path - see main/index.ts, which quits the app in response). */
  onClosed(callback: () => void): void {
    this.window.on('closed', callback)
  }

  private async run(script: string): Promise<void> {
    await this.ready
    if (this.window.isDestroyed()) return
    try {
      await this.window.webContents.executeJavaScript(script)
    } catch {
      // Best-effort UI update only - never let a setup-screen render glitch
      // take down the actual setup work it's reporting on.
    }
  }

  setStepState(id: string, state: 'active' | 'done' | 'error'): Promise<void> {
    return this.run(`window.__setStep(${JSON.stringify(id)}, ${JSON.stringify(state)})`)
  }

  appendLog(line: string): Promise<void> {
    return this.run(`window.__appendLog(${JSON.stringify(line)})`)
  }

  showFatalError(message: string): Promise<void> {
    return this.run(`window.__showFatalError(${JSON.stringify(message)})`)
  }

  close(): void {
    if (!this.window.isDestroyed()) this.window.close()
  }
}
