# Batch 3: PowerShell Refactoring Plan
**Date:** 2026-11-10 | **Status:** In Progress  
**Target:** 10 PowerShell files with highest countOver violations  
**Baseline:** `scripts/complexity-baseline.json` (81 total PowerShell issues, countOver ≥ 1)

---

## Batch 3 Files (Sorted by Impact)

### Priority 1: countOver=3 (Multiple Functions Over 15)
1. **AIEnrich.psm1** (max=40, countOver=3)
   - Module with AI backend helpers
   - Likely: Invoke-AIApi, request-body builders, fallback logic
   - Pattern: Nested switch/if for provider selection, error handling

2. **JsonSurgeryCore.ps1** (max=28, countOver=3)
   - JSON transformation utility
   - Pattern: Recursive tree traversal, conditional branching on node types

3. **Show-TaxonomyEditor.ps1** (max=53, countOver=3)
   - UI launcher with complex setup orchestration
   - Pattern: Multiple precondition checks, deployment configuration logic

### Priority 2: countOver=2 (Two Functions Over 15)
4. **LogicalFormPass.ps1** (max=44, countOver=2)
5. **Test-EdgeRationaleRegression.ps1** (max=35, countOver=2)
6. **Approve-TaxonomyProposal.ps1** (max=37, countOver=2)
7. **Compare-DebateQuality.ps1** (max=45, countOver=2)
8. **Import-AITriadDocument.ps1** (max=66, countOver=2)
9. **Invoke-QbafConflictAnalysis.ps1** (max=79, countOver=2)
10. **Read-FlightRecorderDump.ps1** (max=76, countOver=2)

---

## Refactoring Strategy (PowerShell)

### Patterns to Extract:
1. **Guard Clauses** (early return on precondition fail)
   - Move validation logic to named filter function
   - Return early if validation fails
   - Reduces CC by 3–5 per extracted guard

2. **Provider/Type Switches** (if/switch on provider or type)
   - Extract each branch into a separate handler function
   - Call appropriate handler from dispatch table or switch
   - Keeps main function focused on orchestration

3. **Error Handling Chains** (nested try/catch/fallback)
   - Extract each fallback strategy into named function
   - Main function chains calls with `if (–not $result) { try next }`
   - Each fallback is testable in isolation

4. **Data Transformation Pipelines**
   - Extract intermediate transformation steps into small functions
   - Chain via `|` or explicit sequential calls
   - Each step is reusable and testable

### Commit Strategy:
- **One file per commit** (clearer history, easier to bisect if needed)
- **Format:** `refactor(ps): extract <motive> in <filename> (t/<issue>)`
- **Test after each commit:** Run relevant Pester tests if available

### Baseline Regeneration:
After all 10 files are done:
```powershell
cd <repo-root>
Update-ComplexityBaseline  # regenerates scripts/complexity-baseline.json
git add scripts/complexity-baseline.json
git commit -m "refactor(ps): regenerate complexity baseline for batch 3"
```

---

## Per-File Extraction Plan

### File 1: AIEnrich.psm1
**Violations:** countOver=3, max=40  
**Status:** Not analyzed yet

**Target:** Reduce countOver from 3 to 1  
**Approach:**
- Analyze main function (likely Invoke-AIApi or request builder)
- Identify 2–3 branching sites (provider dispatch, error handling, fallback chains)
- Extract each branch into `_<Function>Provider<Provider>` or `_<Function><Concern>Handler` helper

---

### File 2: JsonSurgeryCore.ps1
**Violations:** countOver=3, max=28  
**Status:** Not analyzed yet

**Target:** Reduce countOver from 3 to 1  
**Approach:**
- Locate main recursive function
- Extract node-type branching into type-specific handlers
- Use dispatch table or switch to call handlers

---

### File 3: Show-TaxonomyEditor.ps1
**Violations:** countOver=3, max=53  
**Status:** Not analyzed yet

**Target:** Reduce countOver from 3 to 1  
**Approach:**
- Locate main orchestration function
- Extract deployment-config branches into separate functions
- Extract precondition checks into guard functions

---

## Success Criteria

✅ All 10 files refactored  
✅ Total countOver reduced: 22 → 12 (minimum 1 per file)  
✅ ESLint/PSScriptAnalyzer passes  
✅ All Pester tests pass  
✅ Baseline regenerated  
✅ No behavioral changes (same inputs/outputs/errors)  
✅ PR created and merged as T0 auto-merge  

---

## Timeline
- **Refactoring:** ~2–3 hours (one file per 15 min on average)
- **Testing:** ~30 min (run Pester suite once)
- **Baseline regen:** ~5 min
- **PR + merge:** ~10 min

**ETA:** Next 3 hours
