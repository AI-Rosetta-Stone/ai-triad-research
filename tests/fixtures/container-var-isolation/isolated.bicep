// t/4794#9 item 2, t/4953: GREEN fixture -- every *_CONTAINER var read by server-src (all read
// forms) has a prod literal and a staging- override that differs from it.

param fooContainerStaging string = 'staging-foo'

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
