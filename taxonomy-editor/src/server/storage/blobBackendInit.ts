// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4756 (t/4738 prevention): Azure blob backend initialization with fail-closed validation.
 *
 * Extracted from server.ts to keep file size manageable. Handles:
 * - Validation of required container config in hosted profiles
 * - Wiring of Azure Blob Storage backends for user content
 * - Fallback to GitHub backend on validation failure or missing config
 */

import { validateBlobBackendConfig, areBlobBackendsWired } from './blobBackendBoot.js';
import { userContentContainer } from './userContentContainer.js';
import { communityContainer } from './communityContainer.js';
import { briefExportsContainer } from './briefExportsContainer.js';
import * as fileIO from './fileIO.js';
import { log } from '../logger.js';
import type { FlightRecorder } from '../../../../lib/flight-recorder/flightRecorder.js';

export async function initAzureBlobBackends(serverRecorder: FlightRecorder): Promise<void> {
  // t/4756: validate container config at boot; fail-closed if hosted + account URL + missing var.
  validateBlobBackendConfig(process.env);
  const blobAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (blobAccountUrl && areBlobBackendsWired()) {
    const { AzureBlobBackend } = await import('./azureBlobBackend.js');
    fileIO.setUserContentBackend(new AzureBlobBackend({
      accountUrl: blobAccountUrl,
      userContentContainer: userContentContainer(), // t/4733: single env-resolved source, staging isolation
      communityContainer: communityContainer(), // t/4756: single env-resolved source, staging isolation
    }));
    fileIO.setBriefExportBackend(new AzureBlobBackend({
      accountUrl: blobAccountUrl,
      userContentContainer: briefExportsContainer(), // t/4756: single env-resolved source, staging isolation
      communityContainer: briefExportsContainer(),
    }));
    serverRecorder.record({
      type: 'storage.mode', component: 'storage', level: 'info',
      message: 'User content storage: azure-blob',
      data: { accountUrl: blobAccountUrl },
    });
  } else if (blobAccountUrl && !areBlobBackendsWired()) {
    // t/4756: fail-closed — account URL set but validation failed (missing container var in hosted mode).
    // Blob backends not wired; user content falls back to GitHub. /readyz will return 503.
    log.storage.error('AZURE_STORAGE_ACCOUNT_URL is set but required container config is missing — Blob backend not initialized; user content falls back to the primary GitHub backend.');
    serverRecorder.record({
      type: 'storage.mode', component: 'storage', level: 'error',
      message: 'User content storage: github-api fallback (Azure Blob config failed validation)',
    });
  } else {
    log.storage.warn('AZURE_STORAGE_ACCOUNT_URL is unset — Blob backend not initialized; user content will fall back to the primary GitHub backend.');
    serverRecorder.record({
      type: 'storage.mode', component: 'storage', level: 'warn',
      message: 'User content storage: github-api fallback (Azure Blob not configured)',
    });
  }
}
