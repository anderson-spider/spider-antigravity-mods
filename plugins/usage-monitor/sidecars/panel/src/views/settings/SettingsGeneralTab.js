/**
 * @fileoverview Preferences Tab 1: `SettingsGeneralTab.js` ("常规").
 * Manages UI Language (`en-US` / `pt-BR` / `auto`), Theme Accent (`host` + 6 swatches),
 * Panel Font Scale (`sm` / `md` / `lg` / `xl`), Pricing Sync, and Plugin Updates.
 */

import {
  defineComponent } from '../../core/component.js';
import {
  applyAppearanceToRoot,
  normalizeClientFontScale,
  normalizeClientThemeAccent,
  resolveSettingsModernUi,
  } from '../../core/appearance.js';
import { h,
  patchAttr,
  patchClasses,
  patchText } from '../../core/domPatch.js';
import { isWindowOverlayMode } from '../../core/httpClient.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { normalizeI18nLanguage,
  setI18nLanguage,
  t } from '../../i18n/index.js';
import {
  saveSettingsPatch,
} from '../../store/telemetryStore.js';
import { normalizePluginUpdateMode } from '../../../shared/settings-normalization.mjs';
import { ThemeColorPicker } from '../../components/settings/ThemeColorPicker.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { SegmentedControl } from '../../components/ui/SegmentedControl.js';

function getLanguageOptions() {
  return [
    { value: 'auto', label: t('settings.gen.langAuto') },
    { value: 'en-US', label: t('settings.gen.langEn') },
    { value: 'pt-BR', label: t('settings.gen.langPt') },
  ];
}

function getFontScaleOptions() {
  return [
    { value: 'sm', label: t('settings.gen.fontSm') },
    { value: 'md', label: t('settings.gen.fontMd') },
    { value: 'lg', label: t('settings.gen.fontLg') },
    { value: 'xl', label: t('settings.gen.fontXl') },
  ];
}

function getModernUiOptions() {
  return [
    { value: 'on', label: t('settings.gen.modernUiOn') },
    { value: 'off', label: t('settings.gen.modernUiOff') },
  ];
}

function getUpdateModeOptions() {
  return [
    { value: 'manual', label: t('settings.gen.updateManual') },
    { value: 'auto', label: t('settings.gen.updateAuto') },
    { value: 'off', label: t('settings.gen.updateOff') },
  ];
}

function formatCloudSyncTimeText(tsMs, updatedAt) {
  if (Number(tsMs) > 0) {
    const d = new Date(Number(tsMs));
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return t('settings.gen.syncAt', { time: timeStr });
  }
  if (updatedAt) {
    return t('settings.gen.pubAt', { date: String(updatedAt).slice(0, 10) });
  }
  return t('settings.gen.defaultPricing');
}

export const SettingsGeneralTab = defineComponent({
  name: 'SettingsGeneralTab',
  setup({ props, onCleanup }) {
    let draftLanguage = 'auto';
    let draftThemeAccent = 'host';
    let draftFontScale = 'md';
    let draftModernUi = true;
    let draftPluginUpdateMode = 'manual';
    let latestSettings = null;
    let latestCloudStatus = null;
    let appearanceTimer = null;
    let appearanceSaveSeq = 0;
    let cloudTimer = null;

    const appearanceStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const cloudStatusMsg = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showAppearanceFeedback(text, autoClearMs = 1500) {
      if (appearanceTimer) {
        clearTimeout(appearanceTimer);
        appearanceTimer = null;
      }
      patchText(appearanceStatusText, text);
      if (text && autoClearMs > 0) {
        appearanceTimer = setTimeout(() => {
          appearanceTimer = null;
          patchText(appearanceStatusText, '');
        }, autoClearMs);
      }
    }

    function showCloudFeedback(text, autoClearMs = 3500) {
      if (cloudTimer) {
        clearTimeout(cloudTimer);
        cloudTimer = null;
      }
      patchText(cloudStatusMsg, text);
      if (text && autoClearMs > 0) {
        cloudTimer = setTimeout(() => {
          cloudTimer = null;
          patchText(cloudStatusMsg, '');
        }, autoClearMs);
      }
    }

    // --- Card 1: 界面与外观 ---
    const appearanceTitleEl = h('span', { text: t('settings.gen.appearanceTitle') });
    const langLabelEl = h('span', { className: 'form-label', text: t('settings.gen.language') });
    const accentLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.themeAccent'),
    });
    const fontLabelEl = h('span', { className: 'form-label', text: t('settings.gen.fontScale') });
    const fontHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.gen.fontHint'),
    });
    const modernUiLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.modernUi'),
    });
    const modernUiHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.gen.modernUiHint'),
    });

    const languageSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.language'),
      modelValue: draftLanguage,
      options: getLanguageOptions(),
      onUpdateModelValue: async (val) => {
        const nextLang = normalizeI18nLanguage(val);
        draftLanguage = nextLang;
        setI18nLanguage(nextLang);
        languageSwitch.setValue(nextLang);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ language: nextLang });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const themeColorPicker = ThemeColorPicker({
      modelValue: draftThemeAccent,
      onUpdateModelValue: async (val) => {
        const nextAccent = normalizeClientThemeAccent(val);
        draftThemeAccent = nextAccent;
        themeColorPicker.refs.setValue(nextAccent);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ themeAccent: nextAccent });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const fontScaleSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.fontScale'),
      modelValue: draftFontScale,
      options: getFontScaleOptions(),
      onUpdateModelValue: async (val) => {
        const nextScale = normalizeClientFontScale(val);
        draftFontScale = nextScale;
        fontScaleSwitch.setValue(nextScale);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ fontScale: nextScale });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
          props.onLayoutChange?.();
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const modernUiSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.modernUi'),
      modelValue: 'on',
      options: getModernUiOptions(),
      onUpdateModelValue: async (val) => {
        const nextModernUi = val !== 'off';
        draftModernUi = nextModernUi;
        modernUiSwitch.setValue(nextModernUi ? 'on' : 'off');
        if (!isWindowOverlayMode() && typeof document !== 'undefined' && document.documentElement) {
          applyAppearanceToRoot(
            document.documentElement,
            {
              ...(latestSettings || {}),
              themeAccent: draftThemeAccent,
              fontScale: draftFontScale,
              modernUi: nextModernUi,
              experimentalModernUi: nextModernUi,
            },
            { includeFontScale: true }
          );
        }
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ modernUi: nextModernUi });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
          props.onLayoutChange?.();
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const appearancePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          appearanceTitleEl,
        ]),
        appearanceStatusText,
      ]),
      h('div', { className: 'form-row' }, [langLabelEl, languageSwitch.el]),
      h('div', { className: 'form-row' }, [accentLabelEl, themeColorPicker.el]),
      h('div', { className: 'form-row' }, [fontLabelEl, fontScaleSwitch.el, fontHintEl]),
      h('div', { className: 'form-row' }, [modernUiLabelEl, modernUiSwitch.el, modernUiHintEl]),
    ]);

    // --- Card 2: 版本更新 ---
    const updateTitleEl = h('span', { text: t('settings.gen.updateTitle') });
    const updateModeLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.updateMode'),
    });
    const pricingCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.gen.pricingLabel'),
    });
    const versionCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.gen.versionLabel'),
    });

    const autoUpdateSelect = CustomSelect({
      modelValue: 'manual',
      icon: 'refresh',
      options: getUpdateModeOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizePluginUpdateMode(val);
        draftPluginUpdateMode = nextMode;
        autoUpdateSelect.setValue(nextMode);
        if (latestCloudStatus) {
          renderCloudStatus(latestCloudStatus);
        }
        showCloudFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            pluginUpdateMode: nextMode,
            autoUpdatePlugin: nextMode === 'auto',
          });
          showCloudFeedback(t('settings.saved'), 1800);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (latestCloudStatus) renderCloudStatus(latestCloudStatus);
          showCloudFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const pricingCountVal = h('strong', { className: 'cell-value', text: '—' });
    const pricingSyncSub = h('span', { className: 'cell-sub', text: t('quota.loading') });
    const versionVal = h('strong', { className: 'cell-value', text: 'v1.4.4' });
    const versionSub = h('span', { className: 'cell-sub', text: t('settings.gen.checkingBtn') });

    const cloudPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('bolt', { size: 13 }),
          updateTitleEl,
        ]),
        cloudStatusMsg,
      ]),
      h('div', { className: 'form-row' }, [updateModeLabelEl, autoUpdateSelect.el]),
      h('div', { className: 'dual-grid' }, [
        h('div', { className: 'matrix-cell' }, [
          pricingCellLabelEl,
          pricingCountVal,
          pricingSyncSub,
        ]),
        h('div', { className: 'matrix-cell' }, [versionCellLabelEl, versionVal, versionSub]),
      ]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [appearancePanel, cloudPanel]);

    function renderSettings(settings) {
      if (!settings) return;
      latestSettings = settings;
      draftLanguage = normalizeI18nLanguage(settings.language);
      draftThemeAccent = normalizeClientThemeAccent(settings.themeAccent);
      draftFontScale = normalizeClientFontScale(settings.fontScale);
      draftModernUi = resolveSettingsModernUi(settings);
      draftPluginUpdateMode = normalizePluginUpdateMode(
        settings.pluginUpdateMode,
        settings.autoUpdatePlugin
      );

      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      themeColorPicker.refs.setValue(draftThemeAccent);
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      modernUiSwitch.setProps({
        modelValue: draftModernUi ? 'on' : 'off',
        options: getModernUiOptions(),
      });
      autoUpdateSelect.setProps({
        modelValue: draftPluginUpdateMode,
        options: getUpdateModeOptions(),
      });
    }

    function renderCloudStatus(cs) {
      if (!cs) return;
      latestCloudStatus = cs;
      const srcLabel =
        cs.source === 'remote'
          ? t('settings.gen.srcRemote')
          : cs.source === 'local'
            ? t('settings.gen.srcLocal')
            : t('settings.gen.srcDefault');
      patchText(pricingCountVal, t('settings.gen.modelCount', { count: cs.modelCount || 0 }));
      patchText(
        pricingSyncSub,
        `${srcLabel} · ${formatCloudSyncTimeText(cs.lastSyncedAtMs, cs.catalogUpdatedAt)}`
      );

      const curVer = cs.currentPluginVersion || '1.4.4';
      const modeTag = cs.installMode === 'git' ? 'Git' : 'ZIP';
      patchText(versionVal, `v${curVer}`);
      if (draftPluginUpdateMode === 'off') {
        patchText(versionSub, t('settings.gen.updateOffSub', { mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': false });
      } else {
        patchText(versionSub, t('settings.gen.latestSub', { mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': false });
      }
    }

    function refreshLabels() {
      patchText(appearanceTitleEl, t('settings.gen.appearanceTitle'));
      patchText(langLabelEl, t('settings.gen.language'));
      patchText(accentLabelEl, t('settings.gen.themeAccent'));
      patchText(fontLabelEl, t('settings.gen.fontScale'));
      patchText(fontHintEl, t('settings.gen.fontHint'));
      patchText(modernUiLabelEl, t('settings.gen.modernUi'));
      patchText(modernUiHintEl, t('settings.gen.modernUiHint'));
      patchText(updateTitleEl, t('settings.gen.updateTitle'));
      patchText(updateModeLabelEl, t('settings.gen.updateMode'));
      patchText(pricingCellLabelEl, t('settings.gen.pricingLabel'));
      patchText(versionCellLabelEl, t('settings.gen.versionLabel'));
      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      themeColorPicker.refs.refreshLabels();
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      modernUiSwitch.setProps({
        ariaLabel: t('settings.gen.modernUi'),
        modelValue: draftModernUi ? 'on' : 'off',
        options: getModernUiOptions(),
      });
      autoUpdateSelect.setProps({
        modelValue: draftPluginUpdateMode,
        options: getUpdateModeOptions(),
      });
      if (latestCloudStatus) {
        renderCloudStatus(latestCloudStatus);
      } else {
        patchText(pricingSyncSub, t('quota.loading'));
      }
    }

    onCleanup(() => {
      if (appearanceTimer) clearTimeout(appearanceTimer);
      if (cloudTimer) clearTimeout(cloudTimer);
      languageSwitch.destroy();
      themeColorPicker.destroy();
      fontScaleSwitch.destroy();
      modernUiSwitch.destroy();
      autoUpdateSelect.destroy();
    });

    return {
      el: rootEl,
      refs: {
        languageSwitch,
        themeColorPicker,
        fontScaleSwitch,
        modernUiSwitch,
        autoUpdateSelect,
        renderSettings,
        renderCloudStatus,
        refreshLabels,
      },
    };
  },
});
