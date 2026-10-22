// Custom ESLint rule: every child_process spawn/exec/execFile/fork call must pass
// `windowsHide: true`.
//
// Why: on Windows, a GUI-subsystem parent (the Electron main process, Orca's feedback-rule
// runner, VS Code) that starts a console program (git, python, pwsh, handle.exe) WITHOUT
// `windowsHide: true` gives the child its own console window, which flashes on screen for
// the child's lifetime. Node's default is `windowsHide: false`. The option is ignored off
// Windows, so adding it never changes behaviour elsewhere. See t/3914 (findings t/3914#1),
// t/3922 (this rule).
//
// What it flags: a call to spawn / spawnSync / exec / execSync / execFile / execFileSync /
// fork whose callee resolves to a `child_process` (or `node:child_process`) binding, through:
//   - named imports, incl. aliases:   import { execFile as run } from 'child_process'
//   - namespace / default imports:    import * as cp from 'child_process'; cp.spawn(...)
//   - require, destructured or not:   const { spawn } = require('child_process'); const cp = require(...)
//   - dynamic import binding:         const { execFile } = await import('child_process')
//   - direct require member call:     require('child_process').execSync(...)
//   - promisify wrappers:             const run = promisify(execFile)  /  util.promisify(cp.exec)
// Bindings are resolved through scope analysis, so a local function that shadows an
// imported name, `RegExp.prototype.exec` (`re.exec(s)`), and node-pty's `pty.spawn` are
// never flagged — only a binding that provably came from child_process is.
//
// Two outcomes are reported:
//   - `missing`      — no options object, or one that provably lacks `windowsHide: true`
//                      (including an explicit `windowsHide: false`).
//   - `unverifiable` — options are passed as something the rule cannot read statically
//                      (an identifier not bound to a same-file object/array literal, a
//                      spread with no explicit windowsHide, a call result). Add the option
//                      inline, or disable the line with a reason.
//
// ROUTE ENUMERATION — paths this rule does NOT cover (t/3922, stated per TL):
//   - `.js` / `.mjs` / `.cjs` scripts outside the linted TS configs (operations/devops
//     predicates, scripts/, CI helpers) — fixed by hand under t/3914's per-owner tickets.
//   - Test files in lib and taxonomy-editor, whose configs wire the rule only in the non-test
//     source block (poviewer / summary-viewer / workflow-app have one block, so tests are linted).
//   - PowerShell `Start-Process` / `&` invocations.
//   - A dynamic import used without a binding (`(await import('child_process')).spawn(...)`
//     or `import('child_process').then(...)`), and options built in another module or passed
//     through a wrapper function's parameter (the wrapper's own call site is what is checked).
//   - Third-party libraries that spawn internally (execa, cross-spawn, simple-git).
//
// Severity: ships at 'warn' everywhere. Promotion to 'error' is a new blocking gate and
// requires a mandatory Second Opinion after the per-owner fixes reach zero (t/3922).

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const SPAWN_METHODS = new Set([
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
]);

function unwrapTs(node) {
  let n = node;
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' ||
    n.type === 'TSTypeAssertion' || n.type === 'TSNonNullExpression')) {
    n = n.expression;
  }
  return n;
}

// `require('child_process')` or `await import('child_process')` — an expression whose value
// is the child_process module object.
function isRequireOfChildProcess(node) {
  const n = unwrapTs(node);
  if (n?.type === 'AwaitExpression') {
    const arg = unwrapTs(n.argument);
    return arg?.type === 'ImportExpression' &&
      arg.source.type === 'Literal' && CHILD_PROCESS_MODULES.has(arg.source.value);
  }
  return n?.type === 'CallExpression' &&
    n.callee.type === 'Identifier' && n.callee.name === 'require' &&
    n.arguments.length === 1 &&
    n.arguments[0].type === 'Literal' &&
    CHILD_PROCESS_MODULES.has(n.arguments[0].value);
}

function propertyName(prop) {
  if (prop.computed) {
    return prop.key.type === 'Literal' ? String(prop.key.value) : null;
  }
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name);
    if (v) return v;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require `windowsHide: true` on child_process spawn/exec/execFile/fork calls (t/3914, t/3922)',
    },
    // t/4238 (TL e/351#2): `report` lets one module run at two severities. `missing` is a definite defect and is
    // registered at 'error'; `unverifiable` (a wrapper or a cross-module options object) is registered at 'warn'
    // under its own rule id, so it can't block a merge that has no fix available. Default: both (pre-t/4238).
    schema: [{
      type: 'object',
      properties: { report: { enum: ['all', 'missing', 'unverifiable'] } },
      additionalProperties: false,
    }],
    messages: {
      missing:
        '`{{method}}` from child_process without `windowsHide: true` — on Windows a GUI parent ' +
        '(Electron, Orca rule runner) gives the child a flashing console window. Add ' +
        '`windowsHide: true` to the options object (ignored off Windows). (t/3914)',
      unverifiable:
        '`{{method}}` from child_process: cannot statically confirm `windowsHide: true` in these ' +
        'options. Add `windowsHide: true` inline in the options literal, or disable this line ' +
        'with a reason. (t/3914)',
    },
  },
  create(context) {
    const report = context.options[0]?.report ?? 'all';
    const sourceCode = context.sourceCode;
    // Variable -> method name it is bound to (e.g. `run` -> 'execFile').
    const methodVars = new Map();
    // Variables bound to the child_process module object itself.
    const moduleVars = new Set();
    // Deferred: promisify(...) declarators and candidate calls, resolved at Program:exit so
    // a call inside a function declared above a module-level binding is still seen.
    const promisifyDecls = [];
    const calls = [];

    function varOf(identifier) {
      return findVariable(sourceCode.getScope(identifier), identifier.name);
    }

    // Returns the child_process method name a callee expression resolves to, or null.
    function resolveMethod(callee) {
      const c = unwrapTs(callee);
      if (!c) return null;
      if (c.type === 'Identifier') {
        const v = varOf(c);
        return v && methodVars.has(v) ? methodVars.get(v) : null;
      }
      if (c.type === 'MemberExpression') {
        const name = c.computed
          ? (c.property.type === 'Literal' ? String(c.property.value) : null)
          : c.property.name;
        if (!name || !SPAWN_METHODS.has(name)) return null;
        const obj = unwrapTs(c.object);
        if (isRequireOfChildProcess(obj)) return name;
        if (obj.type === 'Identifier') {
          const v = varOf(obj);
          if (v && moduleVars.has(v)) return name;
        }
      }
      return null;
    }

    function isPromisify(callee) {
      const c = unwrapTs(callee);
      if (c.type === 'Identifier') return c.name === 'promisify';
      return c.type === 'MemberExpression' && !c.computed && c.property.name === 'promisify';
    }

    // Classifies one argument: 'hidden' (windowsHide: true present), 'notHidden' (an object
    // that provably lacks it), 'ignore' (not an options object: string, array, callback),
    // or 'unknown' (cannot read statically).
    function classifyArg(arg, depth = 0) {
      const a = unwrapTs(arg);
      if (!a) return 'ignore';
      switch (a.type) {
        case 'ObjectExpression': {
          let sawSpread = false;
          for (const p of a.properties) {
            if (p.type === 'SpreadElement') { sawSpread = true; continue; }
            if (propertyName(p) === 'windowsHide') {
              const val = unwrapTs(p.value);
              return val.type === 'Literal' && val.value === true ? 'hidden' : 'notHidden';
            }
          }
          return sawSpread ? 'unknown' : 'notHidden';
        }
        case 'Literal':
        case 'TemplateLiteral':
        case 'ArrayExpression':
        case 'ArrowFunctionExpression':
        case 'FunctionExpression':
          return 'ignore';
        case 'Identifier': {
          if (a.name === 'undefined') return 'ignore';
          if (depth > 3) return 'unknown';
          const v = varOf(a);
          const def = v?.defs.length === 1 ? v.defs[0] : null;
          // Only a `const x = <literal>` is safe to read through; a let/var may be reassigned.
          if (def?.type === 'Variable' && def.parent?.kind === 'const' &&
              def.node.id.type === 'Identifier' && def.node.init) {
            return classifyArg(def.node.init, depth + 1);
          }
          if (def?.type === 'FunctionName') return 'ignore'; // a callback
          return 'unknown';
        }
        default:
          return 'unknown';
      }
    }

    return {
      ImportDeclaration(node) {
        if (!CHILD_PROCESS_MODULES.has(node.source.value)) return;
        for (const spec of node.specifiers) {
          const [v] = sourceCode.getDeclaredVariables(spec);
          if (!v) continue;
          if (spec.type === 'ImportSpecifier') {
            const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
            if (SPAWN_METHODS.has(imported)) methodVars.set(v, imported);
          } else {
            moduleVars.add(v); // default or namespace import
          }
        }
      },
      VariableDeclarator(node) {
        if (!node.init) return;
        if (isRequireOfChildProcess(node.init)) {
          if (node.id.type === 'Identifier') {
            for (const v of sourceCode.getDeclaredVariables(node)) moduleVars.add(v);
          } else if (node.id.type === 'ObjectPattern') {
            for (const p of node.id.properties) {
              if (p.type !== 'Property') continue;
              const key = propertyName(p);
              const val = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
              if (!key || !SPAWN_METHODS.has(key) || val.type !== 'Identifier') continue;
              const v = findVariable(sourceCode.getScope(node), val.name);
              if (v) methodVars.set(v, key);
            }
          }
          return;
        }
        const init = unwrapTs(node.init);
        if (init.type === 'CallExpression' && isPromisify(init.callee) &&
            init.arguments.length >= 1 && node.id.type === 'Identifier') {
          promisifyDecls.push(node);
        }
      },
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        for (const decl of promisifyDecls) {
          const method = resolveMethod(unwrapTs(decl.init).arguments[0]);
          if (!method) continue;
          for (const v of sourceCode.getDeclaredVariables(decl)) methodVars.set(v, method);
        }
        for (const call of calls) {
          const method = resolveMethod(call.callee);
          if (!method) continue;
          let sawUnknown = false;
          let hidden = false;
          // arguments[0] is always the command / file / module path.
          for (const arg of call.arguments.slice(1)) {
            if (arg.type === 'SpreadElement') { sawUnknown = true; continue; }
            const kind = classifyArg(arg);
            if (kind === 'hidden') { hidden = true; break; }
            if (kind === 'unknown') sawUnknown = true;
          }
          if (hidden) continue;
          const messageId = sawUnknown ? 'unverifiable' : 'missing';
          if (report !== 'all' && report !== messageId) continue;
          context.report({ node: call, messageId, data: { method } });
        }
      },
    };
  },
};
