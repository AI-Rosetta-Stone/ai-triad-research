// Fixture source for Test-ContainerVarIsolation.Tests.ps1 -- a single *_CONTAINER read, matching
// the real destructured-env form used by userContentContainer.ts/communityContainer.ts.
export function fooContainerName(env: NodeJS.ProcessEnv): string {
  return env.AZURE_FOO_CONTAINER || 'foo';
}
