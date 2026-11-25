export const WINDOW_BRIDGE_KEY = '__AGUsageMonitorBridge';
export const WINDOW_BRIDGE_ROUTE_KEY = 'hostRouteCascadeId';
export const WINDOW_BRIDGE_ENDPOINT_KEY = 'endpointId';
export const WINDOW_BRIDGE_ENDPOINT_HEADER = 'X-Usage-Monitor-Endpoint';
export const LOCAL_ENDPOINT_ID = 'local';
export const WINDOW_OVERLAY_KEY = '__AGUsageMonitorOverlay';
export const CONTEXT_WINDOWS_GLOBAL_KEY = '__AGUsageMonitorContextWindows';

export const WINDOW_OVERLAY_METHODS = Object.freeze({
  ensureAlive: 'ensureAlive',
  getDockKind: 'getDockKind',
  getMountMode: 'getMountMode',
  updateBridge: 'updateBridge',
  applyMountMode: 'applyMountMode',
  syncHostRoute: 'syncHostRoute',
  deliverRpc: 'deliverRpc',
  dispose: 'dispose',
});

export const BRIDGE_API_ROUTE_DEFS = Object.freeze([
  Object.freeze({ path: '/api/telemetry', method: 'GET', action: 'telemetry' }),
  Object.freeze({ path: '/api/settings', method: 'POST', action: 'settings' }),
  Object.freeze({ path: '/api/context-window', method: 'POST', action: 'context_window' }),
  Object.freeze({ path: '/api/settings/reset', method: 'POST', action: 'settings_reset' }),
  Object.freeze({ path: '/api/cache/rebuild', method: 'POST', action: 'cache_rebuild' }),
]);

export const BRIDGE_API_PATHS = Object.freeze(BRIDGE_API_ROUTE_DEFS.map((r) => r.path));

export function readInjectedWindowBridge() {
  return typeof window === 'undefined' ? undefined : window[WINDOW_BRIDGE_KEY];
}
