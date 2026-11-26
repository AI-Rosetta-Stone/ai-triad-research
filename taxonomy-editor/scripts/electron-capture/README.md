# Electron capture harness (t/645)

Screenshots of the **real desktop app**, for Design evidence and live checks. The harness launches the app
itself with Playwright's Electron mode, runs a scenario, and writes PNGs to a folder you name.

## Rules

- **It only drives an app it launched.** It never attaches to an app that is already running, which
  is why it was chosen over electron-mcp (TL, t/644). Playwright drives the app it launches over a
  debugging port bound to localhost, which closes when the app does.
- **The app gets an allowlisted environment** (system paths, temp and profile folders, locale), never
  this shell's. AI keys, GitHub tokens and other credentials are withheld (Security, t/644).
- **The app runs on a throwaway profile:** a fresh `--user-data-dir` in the temp folder, deleted after
  the run. The harness checks that the app really uses it and stops if it doesn't.
- **`--data-root` is required and must be a scratch copy.** It is refused if it overlaps the real data
  tree (`.aitriad.json` `data_root` or your `AI_TRIAD_DATA_ROOT`) or sits inside any git checkout,
  because the full-tree push publishes the data tree.
- **`--out` must be outside any git checkout**, so shots never land in a commit.
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
mkdir -p /c/tmp/capture-data      # a scratch copy of the data, outside any repo (no .git)
cp -r ../../ai-triad-data/taxonomy ../../ai-triad-data/dictionary /c/tmp/capture-data/
CAPTURE_FIXTURES=/c/tmp/capture-fixtures \
  node scripts/electron-capture/capture.mjs \
    --scenario scripts/electron-capture/scenarios/oped-document.mjs \
    --out /c/tmp/capture-shots --data-root /c/tmp/capture-data
```

- `--exe <path>`: launch a specific packed exe. The default is `release/win-unpacked/*.exe`.
- `--dev`: launch the dev build (`electron .`). It loads http://localhost:5173, so run
  `npm run dev:vite` in the same worktree and make sure nothing else holds that port.
- `--data-root` (required): the scratch copy. The app won't start without `taxonomy/` and `dictionary/` in it.

Exit 0 means the scenario finished; exit 2 means the arguments were refused (the reason is printed). On failure, `--out` holds `harness.log` and `error.png`.

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
