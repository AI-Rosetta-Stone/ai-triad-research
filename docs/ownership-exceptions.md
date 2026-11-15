# Ownership exceptions

**What this is.** Interweave's `resolve-owner` (org-chart app) answers "who owns this path" by folder: a
path's owner is its **deepest claiming role folder**, with the team root as the floor. It can't express an
owner for a single file inside a folder no role claims. The main case is `.github/workflows/`, which GitHub
requires to stay where it is, so every workflow there resolves to the team root.

**Rule:** for any path in this table, **the table wins over `resolve-owner`**. Before you edit a file under
`.github/workflows/`, or any other path listed here, check the table first. Ping the owner it names, and
the required reviewer where one is named.

Rulings by the TL (p/7#131, recorded on t/220). To change a row, get a TL ruling and edit this file.

| Path | Owner | Required reviewer | Why |
|---|---|---|---|
| `.github/workflows/base-image.yml` | Docker | | Image build and pin lifecycle |
| `.github/workflows/container.yml` | Docker | | Image build and pin lifecycle (the earlier Azure claim is withdrawn; TL ruling) |
| `.github/workflows/check-base-pin-drift.yml` | Docker | | Image build and pin lifecycle |
| `.github/workflows/smoke-image.yml` | Docker | | Image build and pin lifecycle |
| `.github/workflows/nudge-container-build.yml` | Docker | | Image build and pin lifecycle |
| `.github/workflows/deployed-image-scan.yml` | DeployAzure | | Image security scanning (Trivy, t/222) |
| `.github/workflows/deploy-azure.yml` | Azure | DeployAzure | Production deploy pipeline (`operations/devops/azure`) |

**Everything else** under `.github/workflows/` with no row here stays with the team root, whatever
`resolve-owner` answers, until a role claims it through a TL ruling recorded here.
