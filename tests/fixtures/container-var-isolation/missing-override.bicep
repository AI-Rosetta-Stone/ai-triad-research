// t/4794#9 item 2: RED fixture -- AZURE_FOO_CONTAINER has NO stagingEnvOverrides entry at all, so
// staging inherits prod's 'foo' (the exact AZURE_ANALYTICS_CONTAINER incident shape: baseEnv has
// it, nobody overrode it). Every other var is wired correctly, so FOO is the only violation.

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
  { name: 'NODE_ENV', value: 'staging' }
  { name: 'AZURE_BRACKET_SQ_CONTAINER', value: 'staging-bracket-sq' }
  { name: 'AZURE_BRACKET_DQ_CONTAINER', value: 'staging-bracket-dq' }
  { name: 'AZURE_DESTRUCT_CONTAINER', value: 'staging-destruct' }
  { name: 'AZURE_MULTI_A_CONTAINER', value: 'staging-multi-a' }
  { name: 'AZURE_MULTI_B_CONTAINER', value: 'staging-multi-b' }
]
