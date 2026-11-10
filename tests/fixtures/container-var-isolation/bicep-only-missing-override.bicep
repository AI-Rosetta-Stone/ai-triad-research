// t/4953 (t/100#4): RED fixture -- AZURE_BICEPONLY_CONTAINER is declared in baseEnv but no server-src
// file reads it (so the code scanner can't see it), and it has no staging override. Bicep-side
// discovery must still catch staging inheriting prod's value.

var baseEnv = [
  { name: 'AZURE_FOO_CONTAINER', value: 'foo' }
  { name: 'AZURE_BRACKET_SQ_CONTAINER', value: 'bracket-sq' }
  { name: 'AZURE_BRACKET_DQ_CONTAINER', value: 'bracket-dq' }
  { name: 'AZURE_DESTRUCT_CONTAINER', value: 'destruct' }
  { name: 'AZURE_MULTI_A_CONTAINER', value: 'multi-a' }
  { name: 'AZURE_MULTI_B_CONTAINER', value: 'multi-b' }
  { name: 'AZURE_BICEPONLY_CONTAINER', value: 'biceponly' }
  { name: 'NODE_ENV', value: 'production' }
]

var stagingEnvOverrides = [
  { name: 'AZURE_FOO_CONTAINER', value: 'staging-foo' }
  { name: 'AZURE_BRACKET_SQ_CONTAINER', value: 'staging-bracket-sq' }
  { name: 'AZURE_BRACKET_DQ_CONTAINER', value: 'staging-bracket-dq' }
  { name: 'AZURE_DESTRUCT_CONTAINER', value: 'staging-destruct' }
  { name: 'AZURE_MULTI_A_CONTAINER', value: 'staging-multi-a' }
  { name: 'AZURE_MULTI_B_CONTAINER', value: 'staging-multi-b' }
]
