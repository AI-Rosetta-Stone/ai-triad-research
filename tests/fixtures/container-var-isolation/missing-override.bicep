// t/4794#9 item 2: RED fixture -- AZURE_FOO_CONTAINER has NO stagingEnvOverrides entry at all
// (the exact AZURE_ANALYTICS_CONTAINER incident shape: baseEnv has it, nobody overrode it).

var baseEnv = [
  { name: 'AZURE_FOO_CONTAINER', value: 'foo' }
  { name: 'NODE_ENV', value: 'production' }
]

var stagingEnvOverrides = [
  { name: 'NODE_ENV', value: 'staging' }
]
