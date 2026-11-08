# PowerShell Agent

A specialized agent for **reviewing and validating** PowerShell code against AI Triad standards.

Generates fixes for issues, never initial implementations (to avoid my writing limitations).

## Calling a command

Every command takes **one JSON object as its only argument** and prints **one JSON object**:

```
app_run {app: "powershell", command: "review", args: ["{\"code\":\"...\",\"path\":\"...\"}"]}
```

Exit 0 is success. A refusal exits 1 and prints `{"error": {"code", "message"}}`. Unknown keys are ignored.

## Scope: PowerShell Only

⚠️ **This agent reviews ONLY PowerShell code (.ps1 files and PowerShell code blocks).**

- ✅ Accepts: PowerShell 7 scripts, cmdlets, functions, DSC configurations
- ❌ Rejects: Bash, shell scripts, batch files, Python, etc.
- **Auto-detect:** If code contains `for ... in`, `echo`, `[[...]]`, or `#!/bin/bash`, agent returns error: `"InvalidLanguage"` with suggestion to convert

## Commands

### `review {code, path?, context?}`

**Purpose:** Validate PowerShell code against AI Triad standards (strict mode, JSON guards, approved verbs, error handling, data paths, type safety, module exports).

**Input:**
- `code` (string, required): PowerShell code to review
- `path` (string, optional): File path context (e.g., `operations/devops/phase0-audit.ps1`)
- `context` (string, optional): "public-cmdlet" | "private-helper" | "devops-script" | "module-root"

**Output:**
```json
{
  "path": "operations/devops/phase0-audit.ps1",
  "language": "powershell",
  "context": "devops-script",
  "valid": false,
  "issues": [
    {
      "line": 5,
      "severity": "error" | "warning" | "info",
      "category": "StrictMode" | "JSONGuard" | "ApprovedVerb" | "ErrorHandling" | "DataPath" | "TypeSafety" | "ModuleExport" | "Logging",
      "message": "ConvertFrom-Json property 'id' accessed without guard",
      "code": "$node.id",
      "fix": "if ($node.PSObject.Properties['id']) { $id = $node.id }"
    }
  ],
  "summary": "3 errors, 1 warning, 0 info",
  "fixes": {
    "strictMode": "Add 'Set-StrictMode -Version Latest' at top",
    "jsonGuards": "Guard 3 ConvertFrom-Json property accesses",
    "errorHandling": "Wrap in Try-Catch with ActionableError"
  }
}
```

**Categories:**
| Category | What | Fix |
|----------|------|-----|
| **StrictMode** | Missing `Set-StrictMode -Version Latest` | Add to line 1 |
| **JSONGuard** | Unguarded JSON property access or `.Count` on JSON array | Wrap in `@()` or guard with `PSObject.Properties['x']` |
| **ApprovedVerb** | Cmdlet uses non-approved verb | Rename with approved verb (Get-, Set-, Add-, Remove-, Invoke-, New-, Test-, Find-, Update-, Resolve-) |
| **ErrorHandling** | Missing Try-Catch or ActionableError | Wrap in Try-Catch; use `New-ActionableError` with Goal/Problem/Location/NextSteps |
| **DataPath** | Hardcoded path instead of `Get-TaxonomyDir`, `Get-SourcesDir`, etc. | Replace with appropriate getter function |
| **TypeSafety** | Output is `[PSCustomObject]` instead of typed class | Define class and return instance |
| **ModuleExport** | Public cmdlet missing from `.psm1` Export-ModuleMember or `.psd1` FunctionsToExport | Add to both locations |
| **Logging** | Fallback path not logged with `Write-Warning` | Add `Write-Warning "Using fallback: $reason"` |
| **LanguageMismatch** | Code is bash/shell, not PowerShell | Convert to PowerShell or route to bash agent |

### `lint {code, path?, strict?}`

**Purpose:** Fast linting without detailed fixes (for pre-commit checks).

**Input:**
- `code` (string, required): PowerShell code to lint
- `path` (string, optional): File path for context
- `strict` (boolean, optional, default=false): Include warnings in failure count

**Output:**
```json
{
  "path": "operations/devops/phase0-audit.ps1",
  "language": "powershell",
  "pass": false,
  "errorCount": 2,
  "warningCount": 1,
  "errors": [
    {
      "line": 3,
      "message": "Missing Set-StrictMode -Version Latest"
    }
  ]
}
```

**Error Conditions:**
- Returns `{"error": {"code": "InvalidLanguage", "message": "This code is bash, not PowerShell. Use bash agent or convert to PowerShell."}}` if bash detected

### `generate-fix {issues, code, path?}`

**Purpose:** Generate corrected code from review issues. Use after `review` to auto-fix common issues.

**Input:**
- `issues` (array, required): Issues from `review` command output
- `code` (string, required): Original PowerShell code
- `path` (string, optional): File path for context
- `autoFix` (boolean, optional, default=true): Auto-fix all fixable issues

**Output:**
```json
{
  "path": "operations/devops/phase0-audit.ps1",
  "fixed": true,
  "originalLength": 450,
  "fixedLength": 520,
  "changes": [
    {
      "line": 1,
      "description": "Added Set-StrictMode -Version Latest"
    }
  ],
  "code": "Set-StrictMode -Version Latest\n\nfunction Invoke-Audit { ... }",
  "remaining": [
    {
      "line": 8,
      "category": "ApprovedVerb",
      "message": "Function name uses 'Fetch-' instead of approved 'Get-'",
      "manual": true
    }
  ]
}
```

## Errors

| `code` | When | What to do |
|---|---|---|
| `InvalidInput` | `code` is missing/empty; invalid JSON | provide valid PowerShell code and JSON |
| `InvalidContext` | `context` is not a recognized value | use "public-cmdlet", "private-helper", "devops-script", or "module-root" |
| `CodeSyntax` | code has syntax errors (can't parse) | fix syntax errors first |
| `InvalidIssues` | `issues` array malformed in generate-fix | run `review` first to get valid issues |
| `InvalidLanguage` | code contains bash/shell syntax (for, echo, [[...]]) | convert to PowerShell or use bash agent |

---

## Language Detection Rules

The agent automatically detects language on input:

```powershell
# Bash detection patterns (will be rejected):
- Shebang: #!/bin/bash, #!/bin/sh, #!/usr/bin/env bash
- Syntax: for ... in, for (( ... )), echo, [[...]], [[ ... ]], ${var}, $(...)
- Keywords: do, then, else, fi, esac, function name() { ... }

# PowerShell patterns (accepted):
- Shebang: #!/usr/bin/env pwsh
- Syntax: foreach, for(;;), Write-Host, [bool], try/catch
- Keywords: param(), function, Set-StrictMode, cmdlet, [CmdletBinding()]
```

If detection is ambiguous, agent asks for clarification via `context` parameter.

---

## Review Workflow

1. **Write or paste code** → call `review`
2. **Review issues** — severity: error (fail), warning (should fix), info (consider)
3. **Auto-fix** → call `generate-fix` to correct common issues
4. **Manual fixes** → for issues marked `"manual": true`, edit by hand
5. **Re-review** → call `review` on fixed code to confirm

---

## Context & Scope Notes

- **Operations/devops scripts MUST be PowerShell**, not bash (enforces consistency across Phase 0/1/2 work)
- **If you have bash in operations/devops/, convert to PowerShell first** — agent will flag and guide
- **Module code (scripts/AITriad/) is always PowerShell 7**
- **Public scripts should use approved verbs** (Get-, Set-, Invoke-, etc.)

---

**Last updated:** 2026-11-07
**Mode:** Reviewer + Auto-fixer (not generator)
**Language Scope:** PowerShell 7 only
