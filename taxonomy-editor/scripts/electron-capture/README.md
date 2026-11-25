# Electron capture harness (t/645)

Screenshots of the **real desktop app**, for Design evidence and live checks. The harness launches the app
itself with Playwright's Electron mode, runs a scenario, and writes PNGs to a folder you name.

## Rules

- **It only drives an app it launched.** It never attaches to a running app or a debugging port. That
  is why it was chosen over electron-mcp (TL, t/644).
- **Stubs stay in the harness.** A scenario may stub `dialog.showOpenDialog` or override an `ipcMain`
  handler at run time (`h.stubOpenDialog`, `h.overrideHandler`). Nothing is added to the product, and
  every shot is labelled with what was stubbed.
- **The app window shows on the PI's screen while it runs.** Keep runs short, and get the TL's go for
  each session of runs.
- **Use fixtures we own**, never real source documents or real user data.

## Run

From `taxonomy-editor/`:

```sh
env -u NoDefaultCurrentDirectoryInExePath npm run pack      # builds release/win-unpacked
CAPTURE_FIXTURES=/path/to/fixtures \
  node scripts/electron-capture/capture.mjs \
    --scenario scripts/electron-capture/scenarios/oped-document.mjs \
    --out /path/to/shots --data-root /path/to/ai-triad-data
```

- `--exe <path>`: launch a specific packed exe. The default is `release/win-unpacked/*.exe`.
- `--dev`: launch the dev build (`electron .`). It loads http://localhost:5173, so run
  `npm run dev:vite` in the same worktree and make sure nothing else holds that port.
- `--data-root`: the app won't start without a readable data root (`AI_TRIAD_DATA_ROOT`).

Exit 0 means the scenario finished. On failure, `--out` holds `harness.log` and `error.png`.

## Write a scenario

A scenario is a module whose default export takes the helpers:

```js
export default async function (h) {
  await h.win.getByRole('button', { name: 'Chat' }).click();   // h.win is the Playwright Page
  await h.setTheme('dark');
  await h.label('PACKED APP - chat - dark');
  await h.shot('chat_dark_1280');
}
```

Helpers: `h.app` (ElectronApplication), `h.win`, `h.note(msg)`, `h.stubOpenDialog(paths)`,
`h.overrideHandler(channel, value)`, `h.setTheme(theme)`, `h.setWidth(w, h?)`, `h.label(text)`, `h.shot(name)`.

`scenarios/oped-document.mjs` is the t/276 check: Document ready (harvard and dark) and failed (harvard).

## Headless extraction check

To test the packed extractor without a window, run a Node script under the packed binary with
`ELECTRON_RUN_AS_NODE=1` and import `resources/app.asar/dist/main/lib/extraction/extractDocumentText.js`
(how t/631 was verified).
