// Fixture source for ContainerVarIsolation.Tests.ps1 (t/4953): the var name held in a constant.
// The scanner can't resolve process.env[NAME] statically, so it must report it as an indirect
// WARN finding -- and must NOT treat AZURE_INDIRECT_CONTAINER as a discovered read.
const NAME = 'AZURE_INDIRECT_CONTAINER';
export function indirectContainer(): string {
  return process.env[NAME] ?? '';
}
