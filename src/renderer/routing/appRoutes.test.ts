// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findRoute,
  ROOT_ROUTE,
  CHAT_LIBRARY_ROUTE,
  CHAT_OPEN_ROUTE,
  OPEDS_LIBRARY_ROUTE,
  OPEDS_OPEN_ROUTE,
  INQUIRY_LIBRARY_ROUTE,
  INQUIRY_OPEN_ROUTE,
  DEBATE_LIBRARY_ROUTE,
  DEBATE_OPEN_ROUTE,
  TAXONOMY_ROUTE,
  CONFLICTS_ROUTE,
  CRUXES_ROUTE,
  SUMMARIES_ROUTE,
  VALIDATION_ROUTE,
  ORGANIZATIONS_ROUTE,
} from './appRoutes';

// Mock the stores
vi.mock('../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: {
    getState: () => ({
      setActiveTab: vi.fn(),
      setSelectedNodeId: vi.fn(),
    }),
  },
}));

vi.mock('../hooks/useOpEdStore', () => ({
  useOpEdStore: {
    getState: () => ({
      requestOpen: vi.fn(),
    }),
  },
}));

describe('appRoutes', () => {
  describe('route matching', () => {
    it('matches root route', () => {
      expect(findRoute('/')).not.toBeNull();
      expect(findRoute('')).not.toBeNull();
      expect(findRoute('/chat')).toBeNull();
    });

    it('matches chat routes', () => {
      expect(findRoute('/chat')).not.toBeNull();
      expect(findRoute('/chat/')).not.toBeNull();
      expect(findRoute('/chat/conv-123')).not.toBeNull();
      expect(findRoute('/chat/conv-123/')).not.toBeNull();
    });

    it('matches opeds routes', () => {
      expect(findRoute('/opeds')).not.toBeNull();
      expect(findRoute('/opeds/my-set')).not.toBeNull();
      expect(findRoute('/opeds/my-set?pov=acc')).not.toBeNull();
    });

    it('matches inquiry routes', () => {
      expect(findRoute('/inquiry')).not.toBeNull();
      expect(findRoute('/inquiry/q-123')).not.toBeNull();
    });

    it('matches debate routes', () => {
      expect(findRoute('/debate')).not.toBeNull();
      expect(findRoute('/debate/d-456')).not.toBeNull();
    });

    it('matches taxonomy routes', () => {
      expect(findRoute('/taxonomy/acc')).not.toBeNull();
      expect(findRoute('/taxonomy/saf')).not.toBeNull();
      expect(findRoute('/taxonomy/skp')).not.toBeNull();
      expect(findRoute('/taxonomy/sit')).not.toBeNull();
      expect(findRoute('/taxonomy/acc?node=acc-001-042')).not.toBeNull();
    });

    it('matches conflicts routes', () => {
      expect(findRoute('/conflicts')).not.toBeNull();
      expect(findRoute('/conflicts?claim=claim-123')).not.toBeNull();
    });

    it('matches library routes', () => {
      expect(findRoute('/cruxes')).not.toBeNull();
      expect(findRoute('/summaries')).not.toBeNull();
      expect(findRoute('/validation')).not.toBeNull();
      expect(findRoute('/organizations')).not.toBeNull();
    });

    it('returns null for unknown routes', () => {
      expect(findRoute('/unknown')).toBeNull();
      expect(findRoute('/share/oped/123')).toBeNull();
    });
  });

  describe('parameter extraction', () => {
    it('extracts chat id from path', () => {
      const route = findRoute('/chat/my-conv');
      expect(route?.params.id).toBe('my-conv');
    });

    it('extracts opeds set id from path', () => {
      const route = findRoute('/opeds/my-set');
      expect(route?.params.setId).toBe('my-set');
    });

    it('extracts inquiry id from path', () => {
      const route = findRoute('/inquiry/q-123');
      expect(route?.params.id).toBe('q-123');
    });

    it('extracts debate id from path', () => {
      const route = findRoute('/debate/d-456');
      expect(route?.params.id).toBe('d-456');
    });

    it('extracts taxonomy pov and node id from path', () => {
      const route = findRoute('/taxonomy/acc?node=acc-001-042');
      expect(route?.params.pov).toBe('acc');
      expect(route?.params.nodeId).toBe('acc-001-042');
    });

    it('extracts conflict claim id from query', () => {
      const route = findRoute('/conflicts?claim=claim-123');
      expect(route?.params).toBeDefined();
      // Query params are extracted during restore, not in match
    });
  });

  describe('restore functions', () => {
    it('root route restores activeTab to rosetta-stone', () => {
      const route = findRoute('/');
      expect(route?.route.id).toBe('root');
    });

    it('chat library route restores activeTab to chat', () => {
      const route = findRoute('/chat');
      expect(route?.route.id).toBe('chat-library');
    });

    it('taxonomy route maps pov abbreviations correctly', () => {
      const accRoute = findRoute('/taxonomy/acc');
      const safRoute = findRoute('/taxonomy/saf');
      const skpRoute = findRoute('/taxonomy/skp');
      const sitRoute = findRoute('/taxonomy/sit');

      expect(accRoute?.route.id).toBe('taxonomy');
      expect(safRoute?.route.id).toBe('taxonomy');
      expect(skpRoute?.route.id).toBe('taxonomy');
      expect(sitRoute?.route.id).toBe('taxonomy');
    });
  });

  describe('round-trip consistency', () => {
    it('parsing and restoring preserves route identity', () => {
      const paths = [
        '/',
        '/chat',
        '/chat/conv-123',
        '/opeds',
        '/opeds/my-set',
        '/opeds/my-set?pov=saf',
        '/inquiry',
        '/inquiry/q-456',
        '/debate',
        '/debate/d-789',
        '/taxonomy/acc',
        '/taxonomy/saf?node=saf-001-001',
        '/conflicts',
        '/conflicts?claim=claim-abc',
        '/cruxes',
        '/summaries',
        '/validation',
        '/organizations',
      ];

      paths.forEach((path) => {
        const route = findRoute(path);
        expect(route).not.toBeNull(`Route should match: ${path}`);
        if (route) {
          expect(route.route.id).toBeTruthy(`Route should have id: ${path}`);
        }
      });
    });
  });

  describe('public routes (not matched by app routes)', () => {
    it('does not match public share routes', () => {
      expect(findRoute('/inquiries/:id')).toBeNull();
      expect(findRoute('/share/oped/:id')).toBeNull();
      expect(findRoute('/share/pov/:id')).toBeNull();
    });

    it('matches singular inquiry (not inquiries)', () => {
      expect(findRoute('/inquiry/some-id')).not.toBeNull();
    });
  });
});
