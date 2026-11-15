// t/4953 (t/100#4): RED fixture -- AZURE_FOO_CONTAINER HAS a stagingEnvOverrides entry, but it
// resolves (via a param default) to prod's own value, so staging still serves prod's container.

param fooContainerStaging string = 'foo'

var baseEnv = [
  { name: 'AZURE_FOO_CONTAINER', value: 'foo' }
  { name: 'AZURE_BRACKET_SQ_CONTAINER', value: 'bracket-sq' }
  { name: 'AZURE_BRACKET_DQ_CONTAINER', value: 'bracket-dq' }
  { name: 'AZURE_DESTRUCT_CONTAINER', value: 'destruct' }
  { name: 'AZURE_MULTI_A_CONTAINER', value: 'multi-a' }
  { name: 'AZURE_MULTI_B_CONTAINER', value: 'multi-b' }
  { name: 'NODE_ENV', value: 'production' }
]

var stagingEnvOverrides = [
  { name: 'AZURE_FOO_CONTAINER', value: fooContainerStaging }
  { name: 'AZURE_BRACKET_SQ_CONTAINER', value: 'staging-bracket-sq' }
  { name: 'AZURE_BRACKET_DQ_CONTAINER', value: 'staging-bracket-dq' }
  { name: 'AZURE_DESTRUCT_CONTAINER', value: 'staging-destruct' }
  { name: 'AZURE_MULTI_A_CONTAINER', value: 'staging-multi-a' }
  { name: 'AZURE_MULTI_B_CONTAINER', value: 'staging-multi-b' }
]
