// Minimal ImportMeta augmentation for import.meta.glob (used in tagSoulRegistry.ts).
// Vite provides the full definition at build time; this stub satisfies tsc in lib/
// without requiring vite as a lib dependency.
interface ImportMeta {
  readonly glob: <T = { default: unknown }>(
    pattern: string,
    options?: { eager?: boolean; import?: string; as?: string; query?: string },
  ) => Record<string, T>;
}
