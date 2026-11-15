# Batch 2 Refactoring Plan — TypeScript Complexity Extraction

**Objective:** Reduce McCabe CC below 15 for top 10 TypeScript files.

## Target Files (from baseline max complexity)
1. `src/renderer/hooks/useDebateStore/slices/clarificationSlice.ts` - max=101, countOver=7
2. `src/renderer/hooks/useDebateStore/slices/debatePhaseSlice.ts` - max=94, countOver=6
3. `src/renderer/components/taxonomy/TaxonomyRefDetail.tsx` - max=75, countOver=4
4. `src/renderer/lib/flightRecorderInit.ts` - max=66, countOver=2
5. `src/renderer/App.tsx` - max=58, countOver=3
6. `src/renderer/hooks/useDebateStore/shared/argumentNetwork.ts` - max=55, countOver=6
7. `src/renderer/hooks/useTaxonomyStore/slices/taxonomyDataSlice.ts` - max=55, countOver=5
8. `src/renderer/utils/errorMessages.ts` - max=55, countOver=1
9. `src/renderer/components/taxonomy/PovTab.tsx` - max=52, countOver=2
10. `src/renderer/components/shared/HarvestDialog.tsx` - max=50, countOver=3

## Strategy
- One file per PR (keep diffs reviewable)
- Extract helper functions and guard clauses
- Apply dispatch tables or polymorphism where applicable
- Preserve all existing behavior and tests
- Tier: T1 (runtime code restructuring)

## Status
- [ ] File 1: clarificationSlice.ts
- [ ] File 2: debatePhaseSlice.ts
- [ ] File 3: TaxonomyRefDetail.tsx
- [ ] File 4: flightRecorderInit.ts
- [ ] File 5: App.tsx
- [ ] File 6: argumentNetwork.ts
- [ ] File 7: taxonomyDataSlice.ts
- [ ] File 8: errorMessages.ts
- [ ] File 9: PovTab.tsx
- [ ] File 10: HarvestDialog.tsx

