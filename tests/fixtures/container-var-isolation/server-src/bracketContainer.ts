// Fixture source for ContainerVarIsolation.Tests.ps1 (t/4953): quoted bracket-access reads.
// AZURE_BRACKET_TIMEOUT is a non-container var and must NOT be discovered.
export function bracketContainers(): string[] {
  return [
    process.env['AZURE_BRACKET_SQ_CONTAINER'] ?? '',
    process.env["AZURE_BRACKET_DQ_CONTAINER"] ?? '',
    process.env['AZURE_BRACKET_TIMEOUT'] ?? '',
  ];
}
