// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import appInsights from 'applicationinsights';

// Initialize Application Insights
appInsights
  .setup(process.env.APPINSIGHTS_INSTRUMENTATION_KEY!)
  .setAutoCollectConsole(true, true)      // Collect console logs
  .setAutoCollectExceptions(true)         // Collect exceptions
  .setAutoCollectPerformance(true)        // Collect performance metrics
  .start();

const client = appInsights.defaultClient;

// Custom properties for all events
client.commonProperties = {
  environment: process.env.NODE_ENV || 'development',
  version: '0.1.0',
};

export { client as telemetryClient };
export default client;
