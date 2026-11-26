/**
 * @fileoverview Entry point for the Usage & Speed Monitor MCP App dashboard.
 */

import { App } from './App.js';
import { applyAppearanceToRoot } from './core/appearance.js';
import { setHostLocaleHint, setI18nLanguage } from './i18n/index.js';
import { startAsyncTelemetryLoop, telemetryStore } from './store/telemetryStore.js';

async function bootstrapApp(mountTarget = document.getElementById('app-root')) {
  if (!mountTarget) return null;

  const initialHostLocale =
    typeof window !== 'undefined' ? window.mcpBridge?.getHostContext?.()?.locale : '';
  if (initialHostLocale) {
    setHostLocaleHint(initialHostLocale);
  }
  const unsubHostLocale =
    typeof window !== 'undefined' && typeof window.mcpBridge?.onHostLocaleChange === 'function'
      ? window.mcpBridge.onHostLocaleChange((locale) => {
          setHostLocaleHint(locale);
        })
      : null;

  const appInstance = App();
  mountTarget.appendChild(appInstance.el);

  const syncDocAppearance = (settings) => {
    setI18nLanguage(settings?.language);
    if (typeof document !== 'undefined' && document.documentElement) {
      applyAppearanceToRoot(document.documentElement, settings, { includeFontScale: true });
    }
  };
  syncDocAppearance(telemetryStore.getState().telemetry?.settings);

  const unsubAppearance = telemetryStore.subscribe(
    (st) => st.telemetry?.settings,
    syncDocAppearance
  );

  let hostThemeObserver = null;
  let colorSchemeMql = null;
  const onHostThemeChange = () => {
    syncDocAppearance(telemetryStore.getState().telemetry?.settings);
  };
  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      hostThemeObserver = new MutationObserver(onHostThemeChange);
      if (document.documentElement) {
        hostThemeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.body) {
        hostThemeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.head) {
        hostThemeObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      colorSchemeMql = window.matchMedia('(prefers-color-scheme: dark)');
      colorSchemeMql?.addEventListener?.('change', onHostThemeChange);
    }
  } catch {
    // ignore observer setup errors in constrained environments
  }

  const stopPolling = startAsyncTelemetryLoop(2000);
  return {
    appInstance,
    stopPolling: () => {
      unsubHostLocale?.();
      hostThemeObserver?.disconnect?.();
      colorSchemeMql?.removeEventListener?.('change', onHostThemeChange);
      unsubAppearance();
      stopPolling();
    },
  };
}

function init() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      void bootstrapApp();
    });
  } else {
    void bootstrapApp();
  }
}

init();
