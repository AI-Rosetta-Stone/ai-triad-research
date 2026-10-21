// Custom ESLint rule: no fs WRITE of a data-root path (t/4372, t/4264's AC4).
//
// Staging inherits AI_TRIAD_DATA_ROOT=/mnt/shared — prod's shared Azure Files share. A write
// under getDataRoot() (or a literal '/mnt/shared' path) from a staging process lands on PROD's
// share, not an isolated per-environment location (t/4264: staging wrote/evicted prod's
// anonymous sessions this way). The fix for class-A writable state is getStateRoot() /
// resolveStatePath(), which defaults to getDataRoot() on prod/local (unchanged there) but
// diverges to an isolated RW mount on staging (t/2643). This rule is the write-side sibling of
// no-raw-data-root-read.js (reads), sharing its same-scope/bounded resolver-tracing approach.
//
// KNOWN LIMITATION (tripwire, not proof — green ≠ verified): catches inline writes and
// SAME-SCOPE const indirection (same bounded hops as the read-side rule). It does NOT follow
// cross-function/cross-module wrapper indirection. A new hit is a true positive requiring TL
// review before it is silenced — not a baseline entry.

const RESOLVERS = new Set(['resolveDataPath', 'getTaxonomyDir', 'getEmbeddingsPath', 'getDataRoot']);
const FS_OBJECTS = new Set(['fs', 'fsp', 'fsPromises']);
const PATH_JOINERS = new Set(['join', 'resolve', 'normalize']);
const WRITE_METHODS = new Set([
  'writeFile', 'writeFileSync',
  'appendFile', 'appendFileSync',
  'mkdir', 'mkdirSync',
  'rename', 'renameSync',
  'unlink', 'unlinkSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync',
]);
const SHARED_MOUNT_LITERAL = '/mnt/shared';
const MAX_HOPS = 6; // same-scope, bounded — not full data-flow

/** A data-root resolver call — bare `foo()` or member `obj.foo()` (e.g. fileIO.getTaxonomyDir()). */
function isResolverCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const c = node.callee;
  if (c.type === 'Identifier') return RESOLVERS.has(c.name);
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && !c.computed) {
    return RESOLVERS.has(c.property.name);
  }
  return false;
}

/** A literal (or template literal with no expressions) containing the shared-mount prefix. */
function isSharedMountLiteral(node) {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value.includes(SHARED_MOUNT_LITERAL);
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.some((q) => q.value.raw.includes(SHARED_MOUNT_LITERAL));
  }
  return false;
}

/** A raw fs write: fs.writeFile(Sync) / fsp.*** / fs.promises.*** — NOT backend.writeFile. */
function isFsWriteCall(node) {
  const c = node.callee;
  if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') return false;
  if (!WRITE_METHODS.has(c.property.name)) return false;
  const obj = c.object;
  if (obj.type === 'Identifier') return FS_OBJECTS.has(obj.name);
  // fs.promises.writeFile
  return obj.type === 'MemberExpression'
    && obj.object.type === 'Identifier' && obj.object.name === 'fs'
    && obj.property.type === 'Identifier' && obj.property.name === 'promises';
}

/** Find a variable binding by walking up the scope chain (same-scope + enclosing scopes). */
function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name);
    if (v) return v;
  }
  return null;
}

/** Does `node` (a path expression) trace to a data-root resolver, or a literal '/mnt/shared'
 *  path, within bounded same-scope hops? */
function tracesToDataRoot(node, scope, depth) {
  if (!node || depth > MAX_HOPS) return false;
  if (isResolverCall(node)) return true;
  if (isSharedMountLiteral(node)) return true;
  // path.join(a, b, …) / path.resolve(…) — traces if ANY argument does
  if (node.type === 'CallExpression'
      && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'path'
      && node.callee.property.type === 'Identifier' && PATH_JOINERS.has(node.callee.property.name)) {
    return node.arguments.some((a) => tracesToDataRoot(a, scope, depth + 1));
  }
  // Array literal → any element tracing counts.
  if (node.type === 'ArrayExpression') {
    return node.elements.some((el) => el && tracesToDataRoot(el, scope, depth + 1));
  }
  // Identifier → resolve to a same-scope `const` and follow its initializer, OR a
  // `for (const x of <array>)` loop variable → follow the iterated array.
  if (node.type === 'Identifier') {
    const variable = findVariable(scope, node.name);
    if (!variable) return false;
    for (const def of variable.defs) {
      if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') continue;
      const decl = def.parent; // the enclosing VariableDeclaration
      if (!decl || decl.kind !== 'const') continue;
      if (decl.parent && decl.parent.type === 'ForOfStatement' && decl.parent.left === decl) {
        if (tracesToDataRoot(decl.parent.right, scope, depth + 1)) return true;
      } else if (def.node.init && tracesToDataRoot(def.node.init, scope, depth + 1)) {
        return true;
      }
    }
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag a raw fs write whose path traces to a data-root resolver or a literal /mnt/shared — '
        + 'route class-A writable state through getStateRoot()/resolveStatePath() (t/4372/t/4264)',
    },
    messages: {
      dataRootWrite:
        'Raw fs write under the DATA root (its argument traces to a data-root resolver or a literal '
        + '/mnt/shared path). A staging deployment sharing that root would write onto PROD\'s share '
        + '(t/4264). Route class-A writable state through getStateRoot()/resolveStatePath() instead — '
        + 'it defaults to getDataRoot() on prod/local (unchanged there) and isolates on staging. If '
        + 'this is a sanctioned exception, add // eslint-disable-next-line local/no-data-root-write -- '
        + '<TL-approved rationale> at the call site. tripwire: green ≠ verified — a new hit needs TL '
        + 'review before silencing.',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        if (!isFsWriteCall(node)) return;
        const pathArg = node.arguments[0];
        if (!pathArg) return;
        const scope = sourceCode.getScope(node);
        if (tracesToDataRoot(pathArg, scope, 0)) {
          context.report({ node, messageId: 'dataRootWrite' });
        }
      },
    };
  },
};
