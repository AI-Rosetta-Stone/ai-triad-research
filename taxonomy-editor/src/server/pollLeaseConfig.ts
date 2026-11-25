// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/509 (t/504): the poll-lease config server.ts hands GitHubAPIBackend. The backend arms the lease only when
// maxReplicas > 1, so at one replica (prod and staging today, main.bicep MAX_REPLICAS '1') nothing changes.
// Omitted when no storage account is configured (local and Electron runs). The container stays the backend's
// default ('poll-coordination') unless Azure names another. Pure, so it is testable without importing server.ts.

export interface PollLeaseConfig {
  accountUrl: string;
  maxReplicas: number;
}

export function pollLeaseConfigFromEnv(env: NodeJS.ProcessEnv, maxReplicas: number): PollLeaseConfig | undefined {
  const accountUrl = env.AZURE_STORAGE_ACCOUNT_URL?.trim();
  if (!accountUrl) return undefined;
  return { accountUrl, maxReplicas };
}
