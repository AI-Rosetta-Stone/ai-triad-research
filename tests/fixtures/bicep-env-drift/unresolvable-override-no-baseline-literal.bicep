// t/4794 fail-closed regression fixture: an override whose value can't be resolved to a literal,
// for a key baseEnv does NOT expose as a literal (the ALLOWED_ORIGINS real-world shape --
// interpolated/resource-ref on both sides, by design). Get-BicepBaseEnv.ps1 -ForStaging must NOT
// throw here: there is no baseEnv literal this key could silently fall back to, so this key was
// never going to be managed by the reconcile either way -- not the incident's failure shape.

var baseEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'ALLOWED_ORIGINS', value: 'https://prod.${someResource.properties.domain}' }
]

var stagingEnvOverrides = [
  { name: 'ALLOWED_ORIGINS', value: 'https://staging.${someResource.properties.domain}' }
]
