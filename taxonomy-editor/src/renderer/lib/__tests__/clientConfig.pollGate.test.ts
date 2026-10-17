// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4251 / t/4258: the poll gate ships switched OFF, so deploying it changes nothing until the server turns it on.

import { describe, it, expect } from 'vitest';
import { getClientConfig } from '../clientConfig';

describe('client config default for the poll gate', () => {
  it('pollGate.enabled defaults to false', () => {
    expect(getClientConfig().pollGate.enabled).toBe(false);
  });
});
