// t/4794 fail-closed regression fixture: an override whose value can't be resolved to a literal
// (a resource-property reference, no literal default) for a key baseEnv DOES expose as a literal.
// Get-BicepBaseEnv.ps1 -ForStaging must THROW here, naming the key -- silently leaving baseEnv's
// (prod) value in place for this key is exactly the t/4794 incident shape.

var baseEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AI_TRIAD_DATA_ROOT', value: '/mnt/shared' }
]

var stagingEnvOverrides = [
  { name: 'AI_TRIAD_DATA_ROOT', value: someResource.properties.unresolvableThing }
]
