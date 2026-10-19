// t/4258 staging kill test, run INSIDE the container: additive crux-evidence write, then signal
// node (PID 7) immediately — well inside the 2s overlay-commit debounce. Usage: node t.js <arm> <SIG>
const [arm, sig] = process.argv.slice(2);
const B = 'http://localhost:7862';
const H = { 'X-Test-Persona': 'authenticated', 'X-Test-Persona-Secret': process.env.TEST_PERSONA_SECRET || '' };
const firstId = (o) => {
  if (Array.isArray(o)) { for (const x of o) { const r = firstId(x); if (r) return r; } return null; }
  if (o && typeof o === 'object') { if (typeof o.id === 'string') return o.id; for (const v of Object.values(o)) { const r = firstId(v); if (r) return r; } }
  return null;
};
(async () => {
  const st = await fetch(`${B}/api/sync/status`, { headers: H });
  const sync = await st.json().catch(() => ({}));
  const r = await fetch(`${B}/api/cruxes`, { headers: H });
  const etag = r.headers.get('etag');
  const id = firstId(await r.json());
  const note = `t/4258 staging SIGTERM/SIGKILL check ${arm} ${new Date().toISOString()}`;
  const p = await fetch(`${B}/api/cruxes/${encodeURIComponent(id)}/evidence`, {
    method: 'POST',
    headers: { ...H, 'If-Match': etag, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/t4258-staging-check', note, added_by: 'staging-test' }),
  });
  const body = (await p.text()).slice(0, 200);
  const t = Date.now();
  console.log('RESULT ' + JSON.stringify({ arm, syncStatus: st.status, branch: sync.session_branch ?? null, crux: id, etag, postStatus: p.status, post: body, note }));
  if (p.status >= 300) { console.log('NOT_KILLING: write failed'); return; }
  process.kill(7, sig);
  console.log(`KILLED ${sig} ${Date.now() - t}ms after the POST response`);
})().catch((e) => { console.log('ERR ' + String(e)); process.exit(1); });
