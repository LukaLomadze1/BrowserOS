/**
 * @file Reusable, accessible building blocks for Settings pages.
 *
 * Every builder returns `{ element, ...updaters }`. Controls never
 * read or write settings themselves: a page passes an `onChange` /
 * `onInput` callback that calls SettingsService, and pushes the
 * service's current values back in through the updaters whenever the
 * service notifies it. Keeping the controls stateless this way means a
 * value changed elsewhere (a category reset, another subsystem) always
 * shows up correctly without a re-render, and focus is never lost.
 *
 * Semantics:
 *  - Choice groups use native radio inputs (visually hidden, still
 *    focusable), so arrow-key navigation and checked state come from
 *    the browser instead of hand-rolled ARIA.
 *  - Toggles are <button role="switch"> with a visible On/Off label,
 *    so state is never conveyed by color alone.
 *  - Sliders are native range inputs with an associated <output> and
 *    an aria-valuetext that includes the unit.
 *  - Dropdowns are native <select> elements.
 *  - Sections can carry an anchor (data-settings-anchor) so search
 *    results and deep links can scroll straight to them.
 *  - Reset buttons use aria-disabled rather than `disabled`, so a
 *    button that was just used (and is now "nothing to reset") keeps
 *    keyboard focus instead of dropping it to <body>.
 */

import { createElement } from "../../utils/dom.js";

let idCounter = 0;

/**
 * @param {string} prefix
 * @returns {string} A document-unique id.
 */
export function uniqueId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * A titled group of related settings.
 * @param {object} config
 * @param {string} config.title
 * @param {string} [config.description]
 * @param {string} [config.anchor] - Deep-link target id within the page (see settingsIndex.js).
 * @param {HTMLElement} [config.headerAction] - e.g. a reset button shown beside the title.
 * @param {HTMLElement[]} config.children
 * @returns {HTMLElement}
 */
export function createSection({ title, description, anchor, headerAction, children }) {
  const titleId = uniqueId("settings-section-title");
  const headerText = createElement("div", {
    className: "settings-section__heading",
    children: [
      createElement("h2", { className: "settings-section__title", attrs: { id: titleId }, text: title }),
      ...(description ? [createElement("p", { className: "settings-section__description", text: description })] : []),
    ],
  });

  const attrs = { "aria-labelledby": titleId };
  if (anchor) attrs["data-settings-anchor"] = anchor;

  return createElement("section", {
    className: "settings-section",
    attrs,
    children: [
      createElement("div", {
        className: "settings-section__header",
        children: headerAction ? [headerText, headerAction] : [headerText],
      }),
      createElement("div", { className: "settings-section__body", children }),
    ],
  });
}

/**
 * Ids for one setting row, generated up front so the control can be
 * built with aria-labelledby / aria-describedby already pointing at
 * the row's label and description.
 * @param {string} name
 * @returns {{labelId: string, descriptionId: string, controlId: string}}
 */
export function createRowIds(name) {
  return {
    labelId: uniqueId(`settings-${name}-label`),
    descriptionId: uniqueId(`settings-${name}-description`),
    controlId: uniqueId(`settings-${name}-control`),
  };
}

/**
 * A label + description + control row.
 * @param {object} config
 * @param {{labelId: string, descriptionId: string}} config.ids
 * @param {string} config.label
 * @param {string} config.description
 * @param {HTMLElement} config.control
 * @param {HTMLElement} [config.reset]
 * @param {"inline"|"stacked"} [config.layout] - "stacked" puts the control on its own line (sliders, wide groups).
 * @returns {{element: HTMLElement, setDescription: (text: string) => void, setMuted: (muted: boolean) => void}}
 */
export function createSettingRow({ ids, label, description, control, reset, layout = "inline" }) {
  const descriptionEl = createElement("p", {
    className: "settings-row__description",
    attrs: { id: ids.descriptionId },
    text: description,
  });

  const element = createElement("div", {
    className: `settings-row settings-row--${layout}`,
    children: [
      createElement("div", {
        className: "settings-row__text",
        children: [
          createElement("span", { className: "settings-row__label", attrs: { id: ids.labelId }, text: label }),
          descriptionEl,
        ],
      }),
      createElement("div", {
        className: "settings-row__control",
        children: reset ? [control, reset] : [control],
      }),
    ],
  });

  return {
    element,
    setDescription(text) {
      descriptionEl.textContent = text;
    },
    setMuted(muted) {
      element.classList.toggle("settings-row--muted", muted);
    },
  };
}

/**
 * A group of mutually exclusive options backed by native radio inputs.
 * @param {object} config
 * @param {string} config.name - Radio group name; must be unique in the document.
 * @param {string} config.labelledBy
 * @param {string} [config.describedBy]
 * @param {string} config.className - Class for the group container.
 * @param {string} config.optionClassName - Class for each option's <label>.
 * @param {Array<{value: string, content: Node}>} config.options - `content` must contain the option's visible text label.
 * @param {(value: string) => void} config.onChange
 * @returns {{element: HTMLElement, setValue: (value: string) => void}}
 */
export function createChoiceGroup({ name, labelledBy, describedBy, className, optionClassName, options, onChange }) {
  const attrs = { role: "radiogroup", "aria-labelledby": labelledBy };
  if (describedBy) attrs["aria-describedby"] = describedBy;
  const element = createElement("div", { className, attrs });

  const inputs = [];
  for (const option of options) {
    const input = createElement("input", {
      className: "settings-choice__input",
      attrs: { type: "radio", name, value: option.value },
      on: {
        change: () => {
          if (input.checked) onChange(option.value);
        },
      },
    });
    inputs.push(input);
    element.append(createElement("label", { className: optionClassName, children: [input, option.content] }));
  }

  return {
    element,
    setValue(value) {
      for (const input of inputs) {
        input.checked = input.value === value;
      }
    },
  };
}

/**
 * Text-only segmented control (a styled choice group).
 * @param {object} config
 * @param {string} config.name
 * @param {string} config.labelledBy
 * @param {string} [config.describedBy]
 * @param {Array<{value: string, label: string}>} config.options
 * @param {(value: string) => void} config.onChange
 * @returns {{element: HTMLElement, setValue: (value: string) => void}}
 */
export function createSegmentedControl({ name, labelledBy, describedBy, options, onChange }) {
  return createChoiceGroup({
    name,
    labelledBy,
    describedBy,
    className: "settings-segmented",
    optionClassName: "settings-segmented__option",
    options: options.map((option) => ({
      value: option.value,
      content: createElement("span", { className: "settings-segmented__label", text: option.label }),
    })),
    onChange,
  });
}

/**
 * A native dropdown.
 * @param {object} config
 * @param {string} config.id
 * @param {string} config.labelledBy
 * @param {string} [config.describedBy]
 * @param {Array<{value: string, label: string}>} config.options
 * @param {(value: string) => void} config.onChange
 * @returns {{element: HTMLElement, setValue: (value: string) => void}}
 */
export function createSelect({ id, labelledBy, describedBy, options, onChange }) {
  const attrs = { id, "aria-labelledby": labelledBy };
  if (describedBy) attrs["aria-describedby"] = describedBy;
  const select = createElement("select", {
    className: "settings-select__input",
    attrs,
    children: options.map((option) => createElement("option", { attrs: { value: option.value }, text: option.label })),
    on: { change: () => onChange(select.value) },
  });
  const element = createElement("div", {
    className: "settings-select",
    children: [select, createElement("span", { className: "settings-select__chevron", attrs: { "aria-hidden": "true" }, text: "\u25be" })],
  });
  return {
    element,
    setValue(value) {
      select.value = value;
    },
  };
}

/**
 * A secondary action button.
 * @param {object} config
 * @param {string} config.label
 * @param {() => void} config.onClick
 * @param {"default"|"danger"} [config.variant]
 * @param {string} [config.ariaLabel]
 * @returns {HTMLButtonElement}
 */
export function createButton({ label, onClick, variant = "default", ariaLabel }) {
  const attrs = { type: "button" };
  if (ariaLabel) attrs["aria-label"] = ariaLabel;
  return createElement("button", {
    className: `settings-button${variant === "danger" ? " settings-button--danger" : ""}`,
    attrs,
    text: label,
    on: { click: onClick },
  });
}

/**
 * An on/off switch.
 * @param {object} config
 * @param {string} config.id
 * @param {string} config.labelledBy
 * @param {string} [config.describedBy]
 * @param {(checked: boolean) => void} config.onChange - Receives the requested new state.
 * @returns {{element: HTMLElement, setChecked: (checked: boolean) => void}}
 */
export function createToggle({ id, labelledBy, describedBy, onChange }) {
  const stateEl = createElement("span", { className: "settings-toggle__state", attrs: { "aria-hidden": "true" } });
  const attrs = { type: "button", role: "switch", id, "aria-checked": "false", "aria-labelledby": labelledBy };
  if (describedBy) attrs["aria-describedby"] = describedBy;

  const element = createElement("button", {
    className: "settings-toggle",
    attrs,
    children: [
      createElement("span", {
        className: "settings-toggle__track",
        attrs: { "aria-hidden": "true" },
        children: [createElement("span", { className: "settings-toggle__thumb" })],
      }),
      stateEl,
    ],
    on: {
      click: () => onChange(element.getAttribute("aria-checked") !== "true"),
    },
  });

  return {
    element,
    setChecked(checked) {
      element.setAttribute("aria-checked", checked ? "true" : "false");
      stateEl.textContent = checked ? "On" : "Off";
    },
  };
}

/**
 * A range slider with a live numeric readout.
 * @param {object} config
 * @param {string} config.id
 * @param {number} config.min
 * @param {number} config.max
 * @param {number} [config.step]
 * @param {string} config.unit - Short unit shown in the readout, e.g. "px".
 * @param {string} config.unitLabel - Spoken unit for aria-valuetext, e.g. "pixels".
 * @param {string} config.labelledBy
 * @param {string} [config.describedBy]
 * @param {(value: number) => void} config.onInput - Called on every input event, for live preview.
 * @returns {{element: HTMLElement, setValue: (value: number) => void, setDisabled: (disabled: boolean) => void}}
 */
export function createSlider({ id, min, max, step = 1, unit, unitLabel, labelledBy, describedBy, onInput }) {
  const attrs = {
    type: "range",
    id,
    min: String(min),
    max: String(max),
    step: String(step),
    "aria-labelledby": labelledBy,
  };
  if (describedBy) attrs["aria-describedby"] = describedBy;

  const outputEl = createElement("output", { className: "settings-slider__value", attrs: { for: id, "aria-hidden": "true" } });

  const render = (value) => {
    outputEl.textContent = unit ? `${value} ${unit}` : String(value);
    input.setAttribute("aria-valuetext", `${value} ${unitLabel}`);
    // The filled part of the track is drawn from this custom property;
    // setting it inline is the only way to express a per-instance value.
    input.style.setProperty("--settings-slider-fill", `${((value - min) / (max - min)) * 100}%`);
  };

  const input = createElement("input", {
    className: "settings-slider__input",
    attrs,
    on: {
      input: () => {
        const value = Number(input.value);
        render(value);
        onInput(value);
      },
    },
  });

  const element = createElement("div", { className: "settings-slider", children: [input, outputEl] });

  return {
    element,
    setValue(value) {
      if (Number(input.value) !== value) input.value = String(value);
      render(value);
    },
    setDisabled(disabled) {
      input.disabled = disabled;
      element.classList.toggle("settings-slider--disabled", disabled);
    },
  };
}

/**
 * A small "Reset" action for one setting.
 * @param {object} config
 * @param {string} config.settingLabel - Human name of the setting, used in the accessible label.
 * @param {() => void} config.onReset
 * @returns {{element: HTMLElement, setAvailable: (available: boolean) => void}}
 */
export function createResetButton({ settingLabel, onReset }) {
  const element = createElement("button", {
    className: "settings-reset-button",
    attrs: { type: "button", "aria-label": `Reset ${settingLabel} to default` },
    text: "Reset",
    on: {
      click: () => {
        if (element.getAttribute("aria-disabled") === "true") return;
        onReset();
      },
    },
  });

  return {
    element,
    setAvailable(available) {
      element.setAttribute("aria-disabled", available ? "false" : "true");
      element.title = available ? `Reset ${settingLabel} to its default` : `${settingLabel} is already at its default`;
    },
  };
}
