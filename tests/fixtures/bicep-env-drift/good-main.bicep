// Minimal fixture for BicepEnvDrift.Tests.ps1 — in-sync baseline.
// Contains only the baseEnv block the parser reads.

// t/4794: a param whose default is a literal string, referenced by a stagingEnvOverrides entry
// (the exact shape that broke in production -- a bare identifier, not a quoted literal).
param aiTriadDataRootStaging string = '/mnt/staging-shared'

var baseEnv = [
  { name: 'AI_TRIAD_DATA_ROOT', value: '/mnt/shared' }
  { name: 'TAXONOMY_CACHE_DIR', value: '/mnt/shared' }
  { name: 'ALLOWED_ORIGINS', value: 'https://taxonomy-editor.${someResource.properties.domain}' }
  { name: 'HOME', value: '/home/aitriad' }
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AZURE_KEYVAULT_URL', value: keyVault.properties.vaultUri }
  { name: 'ADMIN_USERS', value: adminUsers }
  { name: 'WEBSITE_AUTH_ENABLED', value: 'true' }
]

// t/4794: staging overrides -- one plain literal (NODE_ENV, the already-working shape) and one
// param-reference (AI_TRIAD_DATA_ROOT, the shape that silently failed to override baseEnv's prod
// literal in production).
var stagingEnvOverrides = [
  { name: 'NODE_ENV', value: 'staging' }
  { name: 'AI_TRIAD_DATA_ROOT', value: aiTriadDataRootStaging }
]
