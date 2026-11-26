// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Lightweight toast notification for flight recorder dumps.
 * Pure DOM — no React dependency so it can fire from flightRecorderInit.ts
 * (which runs before React mounts).
 */

const TOAST_DURATION_MS = 20_000;
const CONTAINER_ID = 'flight-recorder-toast-container';

function getOrCreateContainer(): HTMLElement {
  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    Object.assign(container.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '99999',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      pointerEvents: 'none',
    });
    document.body.appendChild(container);
  }
  return container;
}

const BTN_STYLE: Partial<CSSStyleDeclaration> = {
  background: '#89b4fa',
  color: '#1e1e2e',
  border: 'none',
  borderRadius: '4px',
  padding: '4px 14px',
  fontSize: '12px',
  fontWeight: '600',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans, sans-serif)',
};

/**
 * Show a toast notification for a flight recorder dump.
 *
 * - Electron: file path + Copy + Open buttons
 * - Web/Azure: clickable download link
 */
export function showDumpToast(opts: {
  filename: string;
  filePath: string;
  isWeb: boolean;
  onCopy?: () => void;
  onOpen?: () => void;
  dumpId?: string;
}): void {
  const container = getOrCreateContainer();

  const toast = document.createElement('div');
  Object.assign(toast.style, {
    position: 'relative',
    background: 'var(--bg-secondary, #1e1e2e)',
    color: 'var(--text-primary, #cdd6f4)',
    border: '1px solid var(--border-color, #45475a)',
    borderRadius: '6px',
    padding: '10px 14px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono, monospace)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    pointerEvents: 'auto',
    maxWidth: '420px',
    opacity: '0',
    transform: 'translateY(10px)',
    transition: 'opacity 0.2s, transform 0.2s',
  });

  const title = document.createElement('div');
  title.textContent = 'Flight recorder dump saved';
  Object.assign(title.style, {
    fontWeight: '600',
    marginBottom: '4px',
    color: 'var(--focus-ring, #89b4fa)',
  });
  toast.appendChild(title);

  if (opts.isWeb) {
    if (opts.dumpId) {
      // Merged dump is THE download — one prominent button, no separate Client:/Server:
      // links (users grabbed the client-only file → 6/8 prod dumps were client-only,
      // t/3067/t/3068). The endpoint interleaves client + server events by timestamp;
      // its isAdmin() gate means non-admins silently get a client-only merged file
      // (diagnostics.ts:163), which is the same content the old Client: link served.
      const mergedLink = document.createElement('a');
      mergedLink.textContent = 'Download dump';
      Object.assign(mergedLink.style, {
        display: 'block',
        color: 'var(--focus-ring, #89b4fa)',
        textDecoration: 'underline',
        cursor: 'pointer',
        wordBreak: 'break-all',
        fontWeight: '600',
      });
      mergedLink.onclick = async (e) => {
        e.preventDefault();
        try {
          const resp = await fetch(`/api/flight-recorder/download-merged/${encodeURIComponent(opts.dumpId!)}`);
          if (!resp.ok) {
            let diag: DiagnosticBody | undefined;
            // eslint-disable-next-line local/require-flight-recorder-in-catch -- dump toast error parsing cannot record through itself
            try { diag = await resp.json() as DiagnosticBody; } catch { /* not JSON */ }
            if (diag && (diag.goal || diag.problem)) {
              showDiagnosticPanel(diag);
            } else {
              mergedLink.textContent = `Download failed (${resp.status})`;
            }
            return;
          }
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `merged-${opts.dumpId}.jsonl`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) { mergedLink.textContent = `Download failed: ${err}`; /* flight recorder UI — silent by design (error shown in toast) */ }
      };
      toast.appendChild(mergedLink);
    } else {
      // No server correlation (dumpId absent) — the client dump is the only download.
      const link = document.createElement('a');
      link.textContent = opts.filename;
      Object.assign(link.style, {
        display: 'block',
        color: 'var(--focus-ring, #89b4fa)',
        textDecoration: 'underline',
        cursor: 'pointer',
        wordBreak: 'break-all',
      });
      link.onclick = async (e) => {
        e.preventDefault();
        try {
          const resp = await fetch(`/api/flight-recorder/download/${encodeURIComponent(opts.filename)}`);
          if (!resp.ok) { link.textContent = `Download failed (${resp.status})`; return; }
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = opts.filename;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) { link.textContent = `Download failed: ${err}`; /* flight recorder UI — silent by design (error shown in toast) */ }
      };
      toast.appendChild(link);
    }
  } else {
    // Electron mode: file path + Copy + Open buttons
    const pathEl = document.createElement('div');
    pathEl.textContent = opts.filePath;
    Object.assign(pathEl.style, {
      wordBreak: 'break-all',
      opacity: '0.8',
      marginBottom: '6px',
    });
    toast.appendChild(pathEl);

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '6px' });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    Object.assign(copyBtn.style, BTN_STYLE);
    copyBtn.onclick = () => {
      opts.onCopy?.();
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    };
    btnRow.appendChild(copyBtn);

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    Object.assign(openBtn.style, BTN_STYLE);
    openBtn.onclick = () => opts.onOpen?.();
    btnRow.appendChild(openBtn);

    toast.appendChild(btnRow);
  }

  // Dismiss button
  const dismiss = document.createElement('button');
  dismiss.textContent = '\u00d7';
  Object.assign(dismiss.style, {
    position: 'absolute',
    top: '4px',
    right: '8px',
    background: 'none',
    border: 'none',
    color: 'var(--text-muted, #6c7086)',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '0 2px',
    lineHeight: '1',
  });
  dismiss.onclick = () => removeToast(toast);
  toast.appendChild(dismiss);

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  // Auto-dismiss
  setTimeout(() => removeToast(toast), TOAST_DURATION_MS);
}

/**
 * Show a pending toast while a flight recorder dump is in progress.
 * Returns a dismiss function — caller is responsible for calling it when the dump completes.
 */
export function showDumpPendingToast(): () => void {
  const container = getOrCreateContainer();

  const toast = document.createElement('div');
  Object.assign(toast.style, {
    position: 'relative',
    background: 'var(--bg-secondary, #1e1e2e)',
    color: 'var(--text-primary, #cdd6f4)',
    border: '1px solid var(--focus-ring, #89b4fa)',
    borderRadius: '6px',
    padding: '10px 14px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono, monospace)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    pointerEvents: 'auto',
    maxWidth: '420px',
    opacity: '0',
    transform: 'translateY(10px)',
    transition: 'opacity 0.2s, transform 0.2s',
  });

  const title = document.createElement('div');
  title.textContent = 'Saving flight recorder dump…';
  Object.assign(title.style, {
    fontWeight: '600',
    color: 'var(--focus-ring, #89b4fa)',
  });
  toast.appendChild(title);

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  return () => removeToast(toast);
}

/**
 * Show an error toast when a flight recorder dump fails to persist.
 * Offers a retry button and (web-only) a client-side blob download fallback.
 */
/** The failure toast's line. Web sends the report to the server and offers Save locally; desktop writes it to disk. */
export function dumpFailedLine(isWeb: boolean): string {
  return isWeb
    ? "Couldn't send the diagnostic report. Try again, or save it locally."
    : "Couldn't save the diagnostic report. Try again.";
}

export function showDumpErrorToast(opts: {
  errorMessage: string;
  isWeb: boolean;
  ndjson: string;
  onRetry: () => void;
}): void {
  const container = getOrCreateContainer();

  const toast = document.createElement('div');
  Object.assign(toast.style, {
    position: 'relative',
    background: 'var(--bg-secondary, #1e1e2e)',
    color: 'var(--text-primary, #cdd6f4)',
    border: '1px solid #f38ba8',
    borderRadius: '6px',
    padding: '10px 14px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono, monospace)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    pointerEvents: 'auto',
    maxWidth: '420px',
    opacity: '0',
    transform: 'translateY(10px)',
    transition: 'opacity 0.2s, transform 0.2s',
  });

  const title = document.createElement('div');
  title.textContent = 'Diagnostic report failed'; // t/673 (Design p/25#190)
  Object.assign(title.style, {
    fontWeight: '600',
    marginBottom: '4px',
    color: '#f38ba8',
  });
  toast.appendChild(title);

  const msg = document.createElement('div');
  // t/673 (Design p/25#188): a plain line, never the raw ActionableError; the detail goes to the console.
  msg.textContent = dumpFailedLine(opts.isWeb);
  console.warn('WARN: flight recorder dump failed; the toast shows a plain line, detail here:', opts.errorMessage);
  Object.assign(msg.style, { opacity: '0.7', marginBottom: '8px', wordBreak: 'break-all' });
  toast.appendChild(msg);

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '6px' });

  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry';
  Object.assign(retryBtn.style, BTN_STYLE);
  retryBtn.onclick = () => {
    removeToast(toast);
    opts.onRetry();
  };
  btnRow.appendChild(retryBtn);

  if (opts.isWeb) {
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save locally';
    Object.assign(saveBtn.style, { ...BTN_STYLE, background: '#a6e3a1' });
    saveBtn.onclick = () => {
      const blob = new Blob([opts.ndjson], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `flight-dump-${ts}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
      saveBtn.textContent = 'Saved';
      saveBtn.disabled = true;
    };
    btnRow.appendChild(saveBtn);
  }

  toast.appendChild(btnRow);

  // Dismiss button
  const dismiss = document.createElement('button');
  dismiss.textContent = '×';
  Object.assign(dismiss.style, {
    position: 'absolute',
    top: '4px',
    right: '8px',
    background: 'none',
    border: 'none',
    color: 'var(--text-muted, #6c7086)',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '0 2px',
    lineHeight: '1',
  });
  dismiss.onclick = () => removeToast(toast);
  toast.appendChild(dismiss);

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  setTimeout(() => removeToast(toast), TOAST_DURATION_MS);
}

function removeToast(toast: HTMLElement): void {
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(10px)';
  setTimeout(() => toast.remove(), 200);
}

interface DiagnosticBody {
  error?: string;
  goal?: string;
  problem?: string;
  location?: string;
  nextSteps?: string[];
  dumpId?: string;
  requestId?: string;
}

function showDiagnosticPanel(body: DiagnosticBody): void {
  const container = getOrCreateContainer();

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'relative',
    background: 'var(--bg-secondary, #1e1e2e)',
    color: 'var(--text-primary, #cdd6f4)',
    border: '1px solid #f38ba8',
    borderRadius: '6px',
    padding: '12px 14px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono, monospace)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    pointerEvents: 'auto',
    maxWidth: '480px',
    userSelect: 'text',
    opacity: '0',
    transform: 'translateY(10px)',
    transition: 'opacity 0.2s, transform 0.2s',
  });

  const title = document.createElement('div');
  title.textContent = 'Merged dump download failed';
  Object.assign(title.style, { fontWeight: '600', marginBottom: '8px', color: '#f38ba8' });
  panel.appendChild(title);

  const fields: [string, string | undefined][] = [
    ['Goal', body.goal],
    ['Problem', body.problem],
    ['Location', body.location],
    ['Error', body.error],
    ['Dump ID', body.dumpId],
    ['Request ID', body.requestId],
  ];

  for (const [label, value] of fields) {
    if (!value) continue;
    const row = document.createElement('div');
    Object.assign(row.style, { marginBottom: '4px', wordBreak: 'break-all' });
    const b = document.createElement('strong');
    b.textContent = `${label}: `;
    Object.assign(b.style, { color: 'var(--text-muted, #6c7086)' });
    row.appendChild(b);
    row.appendChild(document.createTextNode(value));
    panel.appendChild(row);
  }

  if (body.nextSteps && body.nextSteps.length > 0) {
    const stepsLabel = document.createElement('div');
    stepsLabel.textContent = 'Next Steps:';
    Object.assign(stepsLabel.style, { fontWeight: '600', color: 'var(--text-muted, #6c7086)', marginTop: '6px', marginBottom: '2px' });
    panel.appendChild(stepsLabel);
    const ul = document.createElement('ul');
    Object.assign(ul.style, { margin: '0', paddingLeft: '18px' });
    for (const step of body.nextSteps) {
      const li = document.createElement('li');
      li.textContent = step;
      Object.assign(li.style, { marginBottom: '2px' });
      ul.appendChild(li);
    }
    panel.appendChild(ul);
  }

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '6px', marginTop: '8px' });

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy diagnostics';
  Object.assign(copyBtn.style, BTN_STYLE);
  copyBtn.onclick = () => {
    const text = JSON.stringify(body, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy diagnostics'; }, 1500);
    }).catch(() => { /* clipboard — silent by design */ });
  };
  btnRow.appendChild(copyBtn);
  panel.appendChild(btnRow);

  const dismiss = document.createElement('button');
  dismiss.textContent = '×';
  Object.assign(dismiss.style, {
    position: 'absolute', top: '4px', right: '8px',
    background: 'none', border: 'none',
    color: 'var(--text-muted, #6c7086)',
    fontSize: '16px', cursor: 'pointer', padding: '0 2px', lineHeight: '1',
  });
  dismiss.onclick = () => removeToast(panel);
  panel.appendChild(dismiss);

  container.appendChild(panel);
  requestAnimationFrame(() => {
    panel.style.opacity = '1';
    panel.style.transform = 'translateY(0)';
  });
  // No auto-dismiss — persistent until user closes
}
