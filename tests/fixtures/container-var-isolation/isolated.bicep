// t/4794#9 item 2: GREEN fixture -- every *_CONTAINER var isolates cleanly between prod and staging.

param fooContainerStaging string = 'staging-foo'

var baseEnv = [
  { name: 'AZURE_FOO_CONTAINER', value: 'foo' }
  { name: 'NODE_ENV', value: 'production' }
]

var stagingEnvOverrides = [
  { name: 'AZURE_FOO_CONTAINER', value: fooContainerStaging }
]
