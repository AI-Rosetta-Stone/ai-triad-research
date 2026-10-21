// Rule-level Gate Verification for local/no-data-root-write (t/4372, t/4264's AC4).
// RuleTester uses the default espree parser (no TS projectService), so this is the
// deterministic both-arms proof: `invalid` = the FAIL arm — the fault test required by the
// ticket (plant a getDataRoot()/`/mnt/shared` write and show the check fails); `valid` = the
// precision arm (non-data-root writes + the sanctioned backend path stay silent).
import { describe, it, afterAll } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../no-data-root-write.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const rt = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

rt.run('no-data-root-write', rule, {
  valid: [
    // non-data-root base paths — not a resolver, not /mnt/shared
    "import fs from 'fs'; import path from 'path'; fs.writeFileSync(path.join(getStateRoot(), 'x'), 'y');",
    "import fs from 'fs'; import path from 'path'; fs.writeFileSync(path.join(getProjectRoot(), 'x'), 'y');",
    "import fs from 'fs'; fs.writeFileSync('/mnt/staging-state/x', 'y');",
    // cross-function wrapper — the documented KNOWN LIMITATION (closed by convention/review, not this rule)
    "import fs from 'fs'; const p = makePath(); fs.writeFileSync(p, 'y');",
    // backend.writeFile is the sanctioned storage-abstraction path — must NOT be treated as a raw fs write
    "const p = resolveDataPath('x'); backend.writeFile(p, 'y');",
    // a read call must not trip the write rule
    "import fs from 'fs'; fs.readFileSync(getDataRoot());",
  ],
  invalid: [
    // FAULT ARM (t/4372 AC2): a planted getDataRoot() write — the exact shape this rule exists to catch.
    { code: "import fs from 'fs'; fs.writeFileSync(getDataRoot(), 'x');", errors: [{ messageId: 'dataRootWrite' }] },
    { code: "import fs from 'fs'; import path from 'path'; fs.appendFileSync(path.join(getDataRoot(), 'ai-call-log.jsonl'), 'x');", errors: [{ messageId: 'dataRootWrite' }] },
    // literal /mnt/shared path, no resolver involved
    { code: "import fs from 'fs'; fs.mkdirSync('/mnt/shared/anon-sessions', { recursive: true });", errors: [{ messageId: 'dataRootWrite' }] },
    // one-hop const
    { code: "import fs from 'fs'; const p = getDataRoot(); fs.promises.unlink(p);", errors: [{ messageId: 'dataRootWrite' }] },
    // member-form resolver
    { code: "import fs from 'fs'; fs.renameSync(fileIO.getTaxonomyDir(), 'y');", errors: [{ messageId: 'dataRootWrite' }] },
    // other write methods
    { code: "import fs from 'fs'; fs.rmSync(getDataRoot(), { recursive: true });", errors: [{ messageId: 'dataRootWrite' }] },
  ],
});
