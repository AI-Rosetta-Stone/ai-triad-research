// @vitest-environment node
// t/509 (t/504): the poll-lease config server.ts passes to GitHubAPIBackend.
import { describe, it, expect } from 'vitest';
import { pollLeaseConfigFromEnv } from '../pollLeaseConfig.js';

describe('t/509: pollLeaseConfigFromEnv', () => {
  it('with a storage account URL and 3 replicas, gives the lease config', () => {
    expect(pollLeaseConfigFromEnv({ AZURE_STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net' }, 3))
      .toEqual({ accountUrl: 'https://acct.blob.core.windows.net', maxReplicas: 3 });
  });

  it('with no storage account URL (local and Electron), gives none', () => {
    expect(pollLeaseConfigFromEnv({}, 3)).toBeUndefined();
    expect(pollLeaseConfigFromEnv({ AZURE_STORAGE_ACCOUNT_URL: '   ' }, 3)).toBeUndefined();
  });

  it('at one replica it still passes the config; the backend leaves the lease unarmed (maxReplicas <= 1)', () => {
    expect(pollLeaseConfigFromEnv({ AZURE_STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net' }, 1))
      .toEqual({ accountUrl: 'https://acct.blob.core.windows.net', maxReplicas: 1 });
  });

  it('leaves the container to the backend default (no container key)', () => {
    expect(pollLeaseConfigFromEnv({ AZURE_STORAGE_ACCOUNT_URL: 'https://a' }, 3)).not.toHaveProperty('container');
  });
});
