// Fixture source for ContainerVarIsolation.Tests.ps1 (t/4953): destructuring reads, single-name
// and multi-name/multi-line (with a rename and a default). AZURE_DESTRUCT_REGION is a
// non-container var and must NOT be discovered.
export function destructuredContainers(): string[] {
  const { AZURE_DESTRUCT_CONTAINER } = process.env;
  const {
    AZURE_MULTI_A_CONTAINER,
    AZURE_MULTI_B_CONTAINER: multiB = 'fallback',
    AZURE_DESTRUCT_REGION,
  } = process.env;
  return [AZURE_DESTRUCT_CONTAINER ?? '', AZURE_MULTI_A_CONTAINER ?? '', multiB, AZURE_DESTRUCT_REGION ?? ''];
}
