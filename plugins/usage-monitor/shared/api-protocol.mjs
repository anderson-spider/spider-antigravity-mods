/**
 * @fileoverview Shared API route definitions and endpoint constants for
 * Usage & Speed Monitor (MCP server, backend dispatcher, and dashboard UI).
 */

export const LOCAL_ENDPOINT_ID = 'local';

export const BRIDGE_API_ROUTE_DEFS = Object.freeze([
  Object.freeze({ path: '/api/telemetry', method: 'GET', action: 'telemetry' }),
  Object.freeze({ path: '/api/session-health', method: 'GET', action: 'session_health' }),
  Object.freeze({ path: '/api/settings', method: 'POST', action: 'settings' }),
  Object.freeze({ path: '/api/settings/reset', method: 'POST', action: 'settings_reset' }),
  Object.freeze({ path: '/api/cache/rebuild', method: 'POST', action: 'cache_rebuild' }),
]);

export const BRIDGE_API_PATHS = Object.freeze(BRIDGE_API_ROUTE_DEFS.map((r) => r.path));
