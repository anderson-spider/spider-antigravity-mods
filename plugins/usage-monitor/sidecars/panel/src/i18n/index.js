/**
 * @fileoverview Reactive lightweight i18n engine (`en-US` / `pt-BR` / `auto`).
 * Default fallback is `'en-US'` with automatic Portuguese detection for `pt*` system locales.
 */

import { createReactiveStore } from '../core/reactive.js';
import { normalizeLanguageSetting } from '../../shared/settings-normalization.mjs';
import { I18N_MESSAGES_EN_US } from './en-US.js';
import { I18N_MESSAGES_PT_BR } from './pt-BR.js';

export const I18N_DICTIONARIES = Object.freeze({
  'en-US': I18N_MESSAGES_EN_US,
  'pt-BR': I18N_MESSAGES_PT_BR,
});

export function normalizeI18nLanguage(raw) {
  return normalizeLanguageSetting(raw);
}

export function detectHostSystemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      return String(navigator.language).toLowerCase().startsWith('pt') ? 'pt-BR' : 'en-US';
    }
  } catch {
    // Ignore environment navigator read errors
  }
  return 'en-US';
}

export const i18nStore = createReactiveStore({
  language: 'auto',
  locale: detectHostSystemLocale(),
});

export function setI18nLanguage(rawLang) {
  const language = normalizeI18nLanguage(rawLang);
  const locale = language === 'auto' ? detectHostSystemLocale() : language;
  const cur = i18nStore.getState();
  if (cur.language !== language || cur.locale !== locale) {
    i18nStore.setState({ language, locale });
  }
  return locale;
}

export function getEffectiveLocale() {
  return i18nStore.getState().locale || 'en-US';
}

export function isEnglishLocale() {
  return getEffectiveLocale() === 'en-US';
}

export function isPortugueseLocale() {
  return getEffectiveLocale() === 'pt-BR';
}

/**
 * Translate a message key with optional `{name}` variable interpolation.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars = undefined) {
  const locale = getEffectiveLocale();
  const dict = I18N_DICTIONARIES[locale] || I18N_MESSAGES_EN_US;
  const template = dict[key] ?? I18N_MESSAGES_EN_US[key] ?? key;
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}
