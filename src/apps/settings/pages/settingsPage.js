/**
 * @file SettingsPage — base class for Settings pages whose controls
 * map directly onto settings keys.
 *
 * A subclass implements `buildSections()` and uses the row helpers
 * (`toggleRow`, `segmentedRow`, `selectRow`, `sliderRow`), each of which
 * builds an accessible control bound to one setting key:
 *
 *  - user input calls settingsService.set(key, …);
 *  - every bound control is re-synced from SettingsService whenever any
 *    of the page's categories changes, wherever the change came from
 *    (another window, a reset, a context menu) — so a page never shows
 *    a stale value and never re-renders, which keeps keyboard focus;
 *  - every row gets a per-setting Reset button;
 *  - the page ends with a "Reset <category>" section that confirms
 *    before calling settingsService.resetCategory().
 *
 * Page contract (see settingsCategories.js): getElement(), destroy().
 * Subclasses register any extra cleanup with `addCleanup()`.
 */

import { createElement } from "../../../utils/dom.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { showConfirmDialog } from "../../../components/dialog/confirmDialog.js";
import {
  createSection,
  createRowIds,
  createSettingRow,
  createSegmentedControl,
  createSelect,
  createToggle,
  createSlider,
  createResetButton,
  createButton,
  uniqueId,
} from "../settingsControls.js";

export class SettingsPage {
  /**
   * @param {object} config
   * @param {string} config.category - Settings category this page edits (reset target).
   * @param {string} config.title
   * @param {string} config.intro
   * @param {string} config.resetLabel - e.g. "desktop settings".
   * @param {string[]} [config.watchCategories] - Categories whose changes re-sync the page; defaults to [category].
   * @param {object} [context] - Services handed to pages by the Settings app.
   */
  constructor(config, context = {}) {
    this.config = config;
    this.context = context;
    this._destroyed = false;
    /** @type {Array<() => void>} */
    this._cleanups = [];
    /** @type {Array<(values: Readonly<Record<string, *>>) => void>} */
    this._syncers = [];

    this._element = createElement("div", {
      className: "settings-page",
      children: [
        createElement("header", {
          className: "settings-page__header",
          children: [
            createElement("h1", { className: "settings-page__title", attrs: { tabindex: "-1" }, text: config.title }),
            createElement("p", { className: "settings-page__intro", text: config.intro }),
          ],
        }),
        ...this.buildSections(),
        this._buildCategoryResetSection(),
      ],
    });

    for (const category of config.watchCategories ?? [config.category]) {
      this._cleanups.push(settingsService.subscribeCategory(category, () => this.sync()));
    }
    this.sync();
  }

  /**
   * Subclasses return their section elements, in order.
   * @returns {HTMLElement[]}
   */
  buildSections() {
    return [];
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._element;
  }

  /** @returns {boolean} */
  isDestroyed() {
    return this._destroyed;
  }

  /**
   * @param {() => void} cleanup
   * @returns {void}
   */
  addCleanup(cleanup) {
    this._cleanups.push(cleanup);
  }

  /**
   * Register a function that receives every setting value whenever the
   * page re-syncs. Used for custom controls and dependent UI.
   * @param {(values: Readonly<Record<string, *>>) => void} syncer
   * @returns {void}
   */
  addSyncer(syncer) {
    this._syncers.push(syncer);
  }

  /** @returns {void} */
  sync() {
    if (this._destroyed) return;
    const values = settingsService.getAll();
    for (const syncer of this._syncers) {
      try {
        syncer(values);
      } catch (error) {
        console.error(`[Settings] failed to sync the ${this.config.title} page:`, error);
      }
    }
  }

  /** @returns {void} */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  // ---------------------------------------------------------------
  // Builders
  // ---------------------------------------------------------------

  /**
   * @param {{anchor: string, title: string, description?: string, children: HTMLElement[], headerAction?: HTMLElement}} config
   * @returns {HTMLElement}
   */
  section(config) {
    return createSection(config);
  }

  /**
   * @param {string} key
   * @param {string} label
   * @param {string} description
   * @returns {ReturnType<typeof createSettingRow>}
   */
  toggleRow(key, label, description) {
    const ids = createRowIds(rowName(key));
    const toggle = createToggle({
      id: ids.controlId,
      labelledBy: ids.labelId,
      describedBy: ids.descriptionId,
      onChange: (checked) => settingsService.set(key, checked),
    });
    this.addSyncer((values) => toggle.setChecked(values[key]));
    return this._row(key, label, description, ids, toggle.element, "inline");
  }

  /**
   * @param {string} key
   * @param {string} label
   * @param {string} description
   * @param {Array<{value: string, label: string}>} options
   * @returns {ReturnType<typeof createSettingRow>}
   */
  segmentedRow(key, label, description, options) {
    const ids = createRowIds(rowName(key));
    const control = createSegmentedControl({
      name: uniqueId(rowName(key)),
      labelledBy: ids.labelId,
      describedBy: ids.descriptionId,
      options,
      onChange: (value) => settingsService.set(key, coerceToSchemaType(key, value)),
    });
    this.addSyncer((values) => control.setValue(String(values[key])));
    return this._row(key, label, description, ids, control.element, "inline");
  }

  /**
   * @param {string} key
   * @param {string} label
   * @param {string} description
   * @param {Array<{value: string, label: string}>} options
   * @returns {ReturnType<typeof createSettingRow>}
   */
  selectRow(key, label, description, options) {
    const ids = createRowIds(rowName(key));
    const control = createSelect({
      id: ids.controlId,
      labelledBy: ids.labelId,
      describedBy: ids.descriptionId,
      options,
      onChange: (value) => settingsService.set(key, coerceToSchemaType(key, value)),
    });
    this.addSyncer((values) => control.setValue(String(values[key])));
    return this._row(key, label, description, ids, control.element, "inline");
  }

  /**
   * Slider whose range comes from the schema descriptor.
   * @param {string} key
   * @param {string} label
   * @param {string} description
   * @param {{unit: string, unitLabel: string}} units
   * @returns {ReturnType<typeof createSettingRow> & {slider: ReturnType<typeof createSlider>}}
   */
  sliderRow(key, label, description, units) {
    const ids = createRowIds(rowName(key));
    const descriptor = settingsService.getDescriptor(key);
    const slider = createSlider({
      id: ids.controlId,
      min: descriptor.min,
      max: descriptor.max,
      unit: units.unit,
      unitLabel: units.unitLabel,
      labelledBy: ids.labelId,
      describedBy: ids.descriptionId,
      onInput: (value) => settingsService.set(key, value),
    });
    this.addSyncer((values) => slider.setValue(values[key]));
    return { ...this._row(key, label, description, ids, slider.element, "stacked"), slider };
  }

  /**
   * A reset button for one key, kept in sync with whether the key is at its default.
   * @param {string} key
   * @param {string} settingLabel
   * @returns {HTMLElement}
   */
  resetButton(key, settingLabel) {
    const control = createResetButton({ settingLabel, onReset: () => settingsService.reset(key) });
    this.addSyncer(() => control.setAvailable(!settingsService.isDefault(key)));
    return control.element;
  }

  /**
   * @param {string} key
   * @param {string} label
   * @param {string} description
   * @param {{labelId: string, descriptionId: string}} ids
   * @param {HTMLElement} control
   * @param {"inline"|"stacked"} layout
   * @returns {ReturnType<typeof createSettingRow>}
   */
  _row(key, label, description, ids, control, layout) {
    return createSettingRow({
      ids,
      label,
      description,
      control,
      reset: this.resetButton(key, label.toLowerCase()),
      layout,
    });
  }

  /** @returns {HTMLElement} */
  _buildCategoryResetSection() {
    const { category, resetLabel, title } = this.config;
    const statusEl = createElement("p", { className: "settings-section__status", attrs: { role: "status" } });
    const button = createButton({
      label: `Reset ${resetLabel}`,
      variant: "danger",
      onClick: async () => {
        const confirmed = await showConfirmDialog({
          title: `Reset ${resetLabel}?`,
          message: `Every option on the ${title} page returns to its default. Files and other data are not affected.`,
          confirmLabel: "Reset",
          destructive: true,
        });
        if (!confirmed || this._destroyed) return;
        settingsService.resetCategory(category);
        statusEl.textContent = `${title} settings were reset to their defaults.`;
      },
    });

    return this.section({
      anchor: "reset",
      title: "Reset",
      description: `Restore every option on this page to its default value.`,
      children: [createElement("div", { className: "settings-section__actions", children: [button] }), statusEl],
    });
  }
}

/**
 * @param {string} key
 * @returns {string} A DOM-id-friendly fragment, e.g. "desktop-iconSize".
 */
function rowName(key) {
  return key.replace(/\./g, "-");
}

/**
 * Form controls report string values; numeric settings (e.g. a history
 * limit offered as a list of choices) are converted back to numbers so
 * they pass schema validation.
 * @param {string} key
 * @param {string} value
 * @returns {string|number}
 */
function coerceToSchemaType(key, value) {
  return settingsService.getDescriptor(key)?.type === "number" ? Number(value) : value;
}
