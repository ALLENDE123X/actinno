/**
 * ACT-015 — perception and action for arbitrary application-form fields.
 *
 * ACT-007 could only fill fields somebody had enumerated in advance: its
 * `INSTRUCTIONS` object listed first name, last name, email, phone, LinkedIn,
 * website, resume and cover letter, and `buildFieldPlan` walked exactly that
 * list. Everything else on a real form — a country dropdown, "Why do you want to
 * work here?", three work-authorization questions, four EEO selects — was
 * structurally invisible, so a Discord Greenhouse form came out with nine
 * required fields blank and could not have passed the board's own validation.
 *
 * This module supplies the two halves of the fix that do **not** involve a
 * language model, and that is the whole point of it being a separate file:
 *
 *  1. **Perception** (`enumerateFormFields`, `harvestOptions`) — reads the DOM
 *     and reports every control on the page: its visible label, its kind, its
 *     required flag, whether it already holds a value, and for option-based
 *     controls the actual option strings a human would see. This is
 *     `document.querySelectorAll` and nothing else. There is no model in it, so
 *     there is nothing here for a hostile form label to influence.
 *
 *  2. **Action** (`applyFieldValue`) — puts one decided value into one control
 *     through Playwright-style locators derived from the perception pass, and
 *     reads it back. Typing a string, choosing a listed option and ticking a box
 *     are deterministic operations once you hold the element; none of them needs
 *     inference, and none of them is performed by handing page-derived text to
 *     something that can act on it.
 *
 * The **decision** half — which value belongs in which field — is deliberately
 * not here. It lives in `resume-parser.ts` (`decideFieldAnswers`), the module
 * that already owns the no-tools LLM path and `assertNoActionSurface()`. So the
 * three concerns that ACT-007 fused are three separate things again: reading a
 * page (this file, no model), deciding an answer (`resume-parser.ts`, a model
 * with no tools), and performing it (this file, no model).
 *
 * ── What "no natural-language instruction" means here ───────────────────────
 * `create-board-account.ts` builds one `act()` instruction from a page-derived
 * label, and earlier reviews flagged that as the residual injection risk in this
 * repo. Nothing in this file does that. Every write goes through
 * `page.locator(selector)` with a selector this module computed from the DOM
 * itself, and every value is passed as an argument to `fill` / `click` /
 * `selectOption`. A form label never becomes a sentence a model reads.
 */

import { type Page } from "@browserbasehq/stagehand";

/** What a control is, as far as filling it in is concerned. */
export type FormFieldKind =
  | "text"
  | "textarea"
  | "select"
  | "combobox"
  | "radio"
  | "checkbox"
  | "file"
  | "other";

/** One control on the page, as the DOM describes it. */
export type EnumeratedField = {
  /**
   * Stable, human-meaningful handle for this field: the visible label, folded to
   * lower case with runs of whitespace collapsed, disambiguated with a numeric
   * suffix when a form repeats a label.
   *
   * It is what `needsInput[].key` reports and what `additionalAnswers` is keyed
   * on, so it has to be something a person can type back without having seen a
   * selector. Derived from the label rather than minted, so the same form
   * produces the same keys on a later, stateless re-run — which is what makes
   * the ask/answer/resume loop work without storing anything.
   */
  key: string;
  /** The element holding the value. Where `fill`/`inputValue` are aimed. */
  selector: string;
  /**
   * What to click to open this control's menu, innermost first.
   *
   * A list rather than a guess, because guessing was wrong. A react-select
   * combobox's real `<input>` is a grid cell inside `.select__input-container`
   * inside `.select__value-container` inside `.select__control`, and *only the
   * outermost of those actually opens the menu* — verified on Discord's live
   * Greenhouse form, where clicking the container left `aria-expanded="false"`
   * and clicking the control set it to `"true"`. Rather than encode one
   * board's DOM, `openMenu` walks this ladder and stops at the first rung that
   * demonstrably opened something.
   */
  activateSelectors: string[];
  /** The visible label a sighted applicant reads, with any `*` marker stripped. */
  label: string;
  kind: FormFieldKind;
  required: boolean;
  /** What the control currently holds. `""` when empty. */
  currentValue: string;
  /** Option strings, when they are known. Empty when unknown or none. */
  options: string[];
  /** One selector per entry in `options`, when the options are individually addressable. */
  optionSelectors: string[];
  /**
   * For a native `<select>` only: each option's `value` attribute, aligned with
   * `options`.
   *
   * Kept apart from the visible text because they are different things and the
   * browser only accepts one of them: `<option value="1">Yes</option>` is chosen
   * by "1", while everything else in this module — the decision call, the policy
   * checks, the report — speaks in the words a human reads. This is the one
   * place the two are translated between.
   */
  optionValues: string[];
  /** False when the options exist but have not been read (an unopened menu). */
  optionsKnown: boolean;
  /** True when `options` is a prefix of a longer list. */
  optionsTruncated: boolean;
  /** `maxlength`, when the control declares one. */
  maxLength: number | null;
  /** Help/description text attached to the control, capped. */
  helpText: string;
};

/** Most option lists are yes/no or a dozen items; a country list is 250. */
const MAX_OPTIONS_REPORTED = 60;

/** A form with more controls than this is not a form, it is a page of tables. */
const MAX_FIELDS = 150;

/** How long one rung of the activation ladder gets before the next is tried. */
const MENU_ATTEMPT_TIMEOUT_MS = 1_500;
/** How long a search control gets to answer a typed query. */
const MENU_SEARCH_TIMEOUT_MS = 4_000;
/**
 * Above this many options, the list is narrowed by typing before anything is
 * clicked.
 *
 * Not a performance tweak — a correctness one, and it was earned. Clicking the
 * correctly-identified first entry of Greenhouse's 244-option phone-country menu
 * selected Afghanistan: a long menu is a scrolling viewport, and an option's
 * position in the document is not where it is painted. Typing the value first
 * collapses the list to a handful, which is short enough to be entirely on
 * screen. The read-back check is what caught it, and is still what backstops it.
 */
const MAX_UNFILTERED_MENU_OPTIONS = 25;
const MENU_POLL_MS = 150;
/** How long a control gets to render the selection after its option is clicked. */
const MENU_SETTLE_TIMEOUT_MS = 1_500;

// ───────────────────────────────────
// Policy patterns — deterministic, and applied outside the model
// ───────────────────────────────────

/**
 * Demographic self-identification questions.
 *
 * Matched against the field's own label, in TypeScript, *before and after* the
 * decision call — so the "never assert a demographic identity for a real person"
 * rule does not depend on a model having read its instructions properly. A field
 * matching this can only ever be declined, asked about, or left alone.
 */
export const EEO_FIELD_RE =
  /\b(gender|sex|race|races|ethnicity|ethnic|hispanic|latino|latinx|veteran|disabilit\w*|sexual orientation|lgbt\w*|queer|transgender|self[-\s]?identif\w*|demographic\w*)\b/i;

/**
 * An option that answers "I would rather not say" — which is a truthful answer
 * to a demographic question, and the only one this system will ever give.
 *
 * Wide on purpose: boards word it as "Decline to self identify", "I don't wish
 * to answer", "I do not want to answer", "Prefer not to say", "I choose not to
 * disclose". Every one of them means the same thing, and picking none of them
 * because the wording was unexpected would leave a required field blank.
 */
export const DECLINE_OPTION_RE =
  /(decline|prefer\s+not|don'?t\s+wish|do\s+not\s+wish|don'?t\s+want\s+to\s+answer|do\s+not\s+want\s+to\s+answer|rather\s+not|choose\s+not|not\s+to\s+(?:say|answer|disclose|identify)|no\s+answer|unspecified)/i;

/**
 * Boxes that record a legal agreement rather than a fact.
 *
 * Ticking one of these on somebody's behalf is making a commitment in their
 * name, which is a different act from reporting where they live. They are always
 * escalated to the user, never inferred.
 */
export const CONSENT_FIELD_RE =
  /\b(agree|agreement|consent|certify|certification|acknowledg|attest|authorize|terms|privacy polic|i confirm|declaration)\b/i;

/** Comparison form for labels, options and values. Never used for display. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The option in `options` that declines to answer, or null. */
export function findDeclineOption(options: readonly string[]): string | null {
  return options.find((option) => DECLINE_OPTION_RE.test(option)) ?? null;
}

// ───────────────────────────────────
// Perception — the DOM, and only the DOM
// ───────────────────────────────────

type RawField = {
  selector: string;
  activateSelectors: string[];
  label: string;
  kind: string;
  required: boolean;
  currentValue: string;
  options: string[];
  optionSelectors: string[];
  optionValues: string[];
  optionsKnown: boolean;
  optionsTruncated: boolean;
  maxLength: number | null;
  helpText: string;
};

/**
 * Serialised into the page, so it must be self-contained: no imports, no closure
 * over anything in this module, no TypeScript that does not survive `toString()`.
 * Written as a real function rather than a template string for the same reason
 * `describeControlInPage` is — so the compiler checks it.
 */
function enumerateFieldsInPage(maxFields: number, maxOptions: number): RawField[] {
  const out: RawField[] = [];

  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const xpathOf = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node.nodeType === 1) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling !== null) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
    }
    return `xpath=/${parts.join("/")}`;
  };

  /**
   * An id-based selector when the id is unique and quotable, an absolute XPath
   * otherwise. Ids survive a React re-render that reorders siblings; XPath does
   * not, which matters because a decision is made between reading the page and
   * writing to it.
   */
  const selectorOf = (element: Element): string => {
    const id = element.getAttribute("id");
    if (id !== null && id !== "" && !/["\\\n\r]/.test(id)) {
      try {
        if (document.querySelectorAll(`[id="${id}"]`).length === 1) return `[id="${id}"]`;
      } catch {
        // A malformed id that breaks the selector parser. Fall through to XPath.
      }
    }
    return xpathOf(element);
  };

  const rectOf = (element: Element): { w: number; h: number } => {
    const box = element.getBoundingClientRect();
    return { w: box.width, h: box.height };
  };

  /**
   * Is this control on screen for a human?
   *
   * The size test is applied to the element *or* to a near ancestor, because a
   * react-select combobox's real `<input>` is a two-pixel grid cell inside a
   * full-width control box. Rejecting it on its own dimensions would make every
   * dropdown on a modern ATS invisible to this pass.
   */
  const isVisible = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    let node: Element | null = element;
    for (let depth = 0; node !== null && depth < 4; depth++) {
      const { w, h } = rectOf(node);
      if (w >= 8 && h >= 8) return true;
      node = node.parentElement;
    }
    return false;
  };

  /**
   * Does this element contain something that would submit the application?
   *
   * The activation ladder climbs ancestors to find the box that opens a
   * dropdown, and a click on a container lands wherever that container's centre
   * happens to be. On a tightly-laid-out form that centre could fall on a
   * button. This module must never be able to submit an application — the same
   * absolute rule `fill-application-form.ts` states — so any ancestor holding a
   * plausible submit control is simply not a rung anybody may click, whatever
   * its size.
   *
   * Deliberately over-broad: it refuses on *any* submit-typed control and on any
   * button whose words read like sending an application. The cost of being wrong
   * in this direction is one dropdown that has to be escalated to the user; the
   * cost of being wrong in the other is an application sent by accident.
   */
  const holdsSubmitControl = (node: Element): boolean => {
    if (node.querySelector('input[type="submit"],button[type="submit"]') !== null) return true;
    const buttons = node.querySelectorAll('button,[role="button"],input[type="button"]');
    for (const button of Array.from(buttons)) {
      const words = clean(
        `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""} ` +
          `${button.getAttribute("value") ?? ""}`
      );
      if (/\b(submit|send|apply|application|finish|complete)\w*\b/i.test(words)) return true;
    }
    return false;
  };

  /**
   * Everything worth clicking to open this control's menu, innermost first.
   *
   * Bounded at both ends: too small to be a control box, and too large to be
   * anything but a section of the page. Clicking a page-wide container to open
   * a dropdown is how a run ends up clicking something else entirely — and
   * `holdsSubmitControl` is what makes "something else" not be Submit.
   */
  const activationLadder = (element: Element): string[] => {
    const out: string[] = [selectorOf(element)];
    let node: Element | null = element.parentElement;
    for (let depth = 0; node !== null && depth < 6 && out.length < 5; depth++) {
      const box = rectOf(node);
      if (
        box.w >= 40 &&
        box.h >= 16 &&
        box.w <= 1200 &&
        box.h <= 240 &&
        !holdsSubmitControl(node)
      ) {
        const selector = selectorOf(node);
        if (!out.includes(selector)) out.push(selector);
      }
      node = node.parentElement;
    }
    return out;
  };

  const labelOf = (element: Element): string => {
    const bits: string[] = [];
    const push = (value: string | null | undefined): void => {
      const text = clean(value);
      if (text !== "") bits.push(text);
    };

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      for (const id of labelledBy.split(/\s+/)) {
        const target = document.getElementById(id);
        if (target !== null) push(target.textContent);
      }
    }
    const ownId = element.getAttribute("id");
    if (bits.length === 0 && ownId !== null && ownId !== "") {
      const escaped = ownId.replace(/["\\]/g, "\\$&");
      const explicit = document.querySelector(`label[for="${escaped}"]`);
      if (explicit !== null) push(explicit.textContent);
    }
    if (bits.length === 0) {
      const wrapping = element.closest("label");
      if (wrapping !== null) push(wrapping.textContent);
    }
    if (bits.length === 0) {
      const block = element.closest("div,fieldset,li,section,td");
      if (block !== null) {
        const blockLabel = block.querySelector("label,legend");
        if (blockLabel !== null) push(blockLabel.textContent);
      }
    }
    if (bits.length === 0) {
      push(element.getAttribute("aria-label"));
      push(element.getAttribute("placeholder"));
      push(element.getAttribute("name"));
    }
    return bits.join(" ").slice(0, 300);
  };

  const helpOf = (element: Element): string => {
    const describedBy = element.getAttribute("aria-describedby");
    if (describedBy === null) return "";
    const bits: string[] = [];
    for (const id of describedBy.split(/\s+/)) {
      // Placeholder and error nodes are described-by targets too, and both are
      // noise: one says "Select...", the other is empty until validation runs.
      if (/-(placeholder|error)$/.test(id)) continue;
      const target = document.getElementById(id);
      if (target === null) continue;
      const text = clean(target.textContent);
      if (text !== "") bits.push(text);
    }
    return bits.join(" ").slice(0, 300);
  };

  /**
   * What a react-select-style combobox currently holds.
   *
   * Its `<input>.value` is the *search* text and is empty even when something is
   * selected — the selection is a rendered `div`. Both are checked, plus the
   * hidden mirror input these widgets keep for native form validation, which is
   * the most reliable of the three when it exists.
   */
  const comboboxValue = (element: Element): string => {
    const own = clean((element as HTMLInputElement).value);
    if (own !== "") return own;
    let shell: Element | null = element;
    for (let depth = 0; shell !== null && depth < 5; depth++) {
      const rendered = shell.querySelector(
        '[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]'
      );
      if (rendered !== null) {
        const text = clean(rendered.textContent);
        if (text !== "") return text;
      }
      const mirror = shell.querySelector('input[aria-hidden="true"][tabindex="-1"]');
      if (mirror !== null) {
        const value = clean((mirror as HTMLInputElement).value);
        if (value !== "") return value;
      }
      shell = shell.parentElement;
    }
    return "";
  };

  const kindOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    const role = (element.getAttribute("role") ?? "").toLowerCase();
    if (role === "combobox") return "combobox";
    if (tag !== "input") return "other";
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "file") return "file";
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    if (
      element.getAttribute("aria-autocomplete") === "list" ||
      element.getAttribute("aria-haspopup") === "listbox"
    ) {
      return "combobox";
    }
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return "skip";
    return "text";
  };

  // Deliberately no `[role="listbox"]`: that is the *popup* a combobox opens,
  // not a control anybody fills in, and Greenhouse keeps one permanently in the
  // DOM for its phone-country picker. Including it produced a phantom field
  // called "List of countries" on every read of a Discord form.
  const nodes = Array.from(
    document.querySelectorAll('input,select,textarea,[role="combobox"]')
  );
  const seen = new Set<Element>();
  const seenRadioGroups = new Set<string>();

  for (const element of nodes) {
    if (out.length >= maxFields) break;
    if (seen.has(element)) continue;
    seen.add(element);

    const kind = kindOf(element);
    if (kind === "skip") continue;
    if (!isVisible(element)) continue;

    const rawLabel = labelOf(element);
    const label = clean(rawLabel.replace(/[*✱]+\s*$/, "").replace(/\(required\)\s*$/i, ""));
    const required =
      (element as HTMLInputElement).required === true ||
      element.getAttribute("aria-required") === "true" ||
      /[*✱]\s*$/.test(rawLabel) ||
      /\(required\)/i.test(rawLabel);

    let options: string[] = [];
    let optionSelectors: string[] = [];
    let optionValues: string[] = [];
    let optionsKnown = false;
    let optionsTruncated = false;
    let currentValue = "";
    let selector = selectorOf(element);
    let activateSelectors = [selector];

    if (kind === "select") {
      const select = element as HTMLSelectElement;
      const all = Array.from(select.options);
      // A first option with an empty value is a placeholder ("Select…"), not an
      // answer anybody would choose.
      const real = all.filter((option) => option.value !== "" && clean(option.textContent) !== "");
      options = real.slice(0, maxOptions).map((option) => clean(option.textContent));
      optionValues = real.slice(0, maxOptions).map((option) => option.value);
      optionsKnown = true;
      optionsTruncated = real.length > options.length;
      currentValue =
        select.selectedIndex >= 0 && select.value !== ""
          ? clean(all[select.selectedIndex]?.textContent)
          : "";
    } else if (kind === "radio") {
      const name = (element as HTMLInputElement).name;
      if (name !== "") {
        if (seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);
      }
      const group = (
        name === ""
          ? [element]
          : Array.from(document.querySelectorAll(`input[type="radio"][name="${name.replace(/["\\]/g, "\\$&")}"]`))
      ) as HTMLInputElement[];
      for (const radio of group) seen.add(radio);
      options = group.slice(0, maxOptions).map((radio) => labelOf(radio) || radio.value);
      optionSelectors = group.slice(0, maxOptions).map((radio) => selectorOf(radio));
      optionsKnown = true;
      optionsTruncated = group.length > options.length;
      const checked = group.find((radio) => radio.checked);
      currentValue = checked === undefined ? "" : labelOf(checked) || checked.value;
      // The group's question is the fieldset legend, not the first radio's label.
      const fieldset = element.closest("fieldset");
      const legend = fieldset?.querySelector("legend");
      const groupLabel = clean(legend?.textContent);
      if (groupLabel !== "") {
        const first = group[0];
        selector = first === undefined ? selector : selectorOf(first);
        activateSelectors = [selector];
      }
    } else if (kind === "checkbox") {
      currentValue = (element as HTMLInputElement).checked ? "checked" : "";
      optionsKnown = true;
    } else if (kind === "combobox") {
      currentValue = comboboxValue(element);
      // Left unknown on purpose: the option list of a scripted dropdown is not
      // in the DOM until the menu is opened, and opening every menu on a page
      // costs a click and a repaint each. `harvestOptions` does it for the
      // fields that actually need it.
      optionsKnown = false;
      activateSelectors = activationLadder(element);
    } else if (kind === "file") {
      const input = element as HTMLInputElement;
      currentValue = input.files !== null && input.files.length > 0 ? `${input.files.length} file(s)` : "";
    } else {
      currentValue = clean((element as HTMLInputElement).value);
    }

    const declaredMax = Number((element as HTMLInputElement).maxLength);
    out.push({
      selector,
      activateSelectors,
      label,
      kind,
      required,
      currentValue,
      options,
      optionSelectors,
      optionValues,
      optionsKnown,
      optionsTruncated,
      maxLength: Number.isFinite(declaredMax) && declaredMax > 0 ? declaredMax : null,
      helpText: helpOf(element),
    });
  }

  return out;
}

/** A JS string literal for `value`, safe to splice into an expression. */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Wraps a local function's source into an expression the browser can evaluate.
 *
 * Two things it fixes, both of which cost this repo a silent failure:
 *
 *  1. **`__name is not defined`.** These modules run under `tsx`, whose esbuild
 *     transform emits `var f = __name((x) => \u2026, "f")` around every function it
 *     keeps a name for. That helper is defined in the *module*, so it travels
 *     into the page inside `toString()` and is not defined there \u2014 the function
 *     throws on its first line, every time, on every page. `describeControl()`
 *     in `fill-application-form.ts` had been failing this way since it was
 *     written: it returned `found: false` for every control, which reads exactly
 *     like "the form is inside an iframe" and was reported as such. A local
 *     identity `__name` in the evaluated scope makes the helper a no-op.
 *
 *  2. **"Uncaught".** A throw inside a CDP `Runtime.evaluate` reaches the SDK as
 *     the bare word "Uncaught" with no message and no stack, which is
 *     indistinguishable from a transport failure. Catching in the page and
 *     returning the stack as data is the only way to see what actually broke.
 */
export function inPageExpression(fn: (...args: never[]) => unknown, args: string): string {
  return (
    `(() => { const __name = (f) => f; try { return (${fn.toString()})(${args}); } ` +
    `catch (e) { return { __error: String((e && e.stack) || e) }; } })()`
  );
}

/** The `{ __error }` an `inPageExpression` returns instead of throwing, if it did. */
export function inPageError(result: unknown): string | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const error = (result as { __error?: unknown }).__error;
  return typeof error === "string" ? error : null;
}

const KINDS: ReadonlySet<string> = new Set([
  "text",
  "textarea",
  "select",
  "combobox",
  "radio",
  "checkbox",
  "file",
  "other",
]);

/**
 * Every control on the page, with a stable key per field.
 *
 * Never throws: a page this cannot read is reported as having no fields, and the
 * caller decides what that means. A perception failure must not be able to fail
 * a run that has already typed real data into a real employer's form.
 */
export async function enumerateFormFields(page: Page): Promise<EnumeratedField[]> {
  let raw: RawField[];
  try {
    const result = await page.evaluate(
      inPageExpression(enumerateFieldsInPage, `${MAX_FIELDS}, ${MAX_OPTIONS_REPORTED}`)
    );
    const failure = inPageError(result);
    if (failure !== null) throw new Error(failure);
    raw = Array.isArray(result) ? (result as RawField[]) : [];
  } catch (err) {
    // Reported rather than swallowed. "The form has no fields" and "the page
    // could not be read" produce the same empty list and completely different
    // conclusions, and the second one is a bug in this file that would
    // otherwise present as a form that mysteriously needs no filling.
    console.warn(
      `[form-fields] could not read the form's controls (treating the page as having none): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  const used = new Map<string, number>();
  const fields: EnumeratedField[] = [];
  for (const entry of raw) {
    if (typeof entry?.selector !== "string" || entry.selector === "") continue;
    const label = typeof entry.label === "string" ? entry.label.slice(0, 300) : "";
    const base = normalizeText(label).slice(0, 80) || `field-${fields.length + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);

    fields.push({
      key: seen === 0 ? base : `${base} #${seen + 1}`,
      selector: entry.selector,
      activateSelectors:
        Array.isArray(entry.activateSelectors) && entry.activateSelectors.length > 0
          ? entry.activateSelectors.map(String)
          : [entry.selector],
      label,
      kind: (KINDS.has(entry.kind) ? entry.kind : "other") as FormFieldKind,
      required: entry.required === true,
      currentValue: typeof entry.currentValue === "string" ? entry.currentValue : "",
      options: Array.isArray(entry.options) ? entry.options.map(String) : [],
      optionSelectors: Array.isArray(entry.optionSelectors)
        ? entry.optionSelectors.map(String)
        : [],
      optionValues: Array.isArray(entry.optionValues) ? entry.optionValues.map(String) : [],
      optionsKnown: entry.optionsKnown === true,
      optionsTruncated: entry.optionsTruncated === true,
      maxLength: typeof entry.maxLength === "number" ? entry.maxLength : null,
      helpText: typeof entry.helpText === "string" ? entry.helpText.slice(0, 300) : "",
    });
  }
  return fields;
}

// ───────────────────────────────────
// Opening a scripted dropdown to see what is in it
// ───────────────────────────────────

/** What one open dropdown looks like from the outside. */
type OpenMenu = {
  texts: string[];
  selectors: string[];
  /** How many options the menu holds in total, before the report cap. */
  count: number;
  /** The control's own `aria-expanded`. True with no options = an async search box. */
  expanded: boolean;
};

const NO_MENU: OpenMenu = { texts: [], selectors: [], count: 0, expanded: false };

/**
 * Reads the options of the menu belonging to **this** control.
 *
 * The scoping is not tidiness. Discord's Greenhouse form keeps 244
 * `[role="option"]` nodes in the document at all times — the phone-country
 * list, rendered up-front and hidden — so a document-wide read would hand every
 * dropdown on the page a list of countries to choose from. Three strategies,
 * narrowest first: what the control says it controls, then the nearest ancestor
 * that actually holds visible options, then (for a menu rendered into a portal
 * at the end of `<body>`) whatever is visible anywhere. Only one menu is ever
 * open at a time, which is what makes the last one safe.
 */
function readOpenMenuInPage(controlSelector: string, maxOptions: number): OpenMenu {
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const xpathOf = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node.nodeType === 1) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling !== null) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
    }
    return `xpath=/${parts.join("/")}`;
  };

  const visible = (node: Element): boolean => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  let control: Element | null = null;
  try {
    const path = controlSelector.startsWith("xpath=")
      ? controlSelector.slice("xpath=".length)
      : controlSelector;
    control =
      path.startsWith("/") || path.startsWith("(")
        ? (document.evaluate(path, document, null, 9, null).singleNodeValue as Element | null)
        : document.querySelector(controlSelector);
  } catch {
    control = null;
  }

  const expanded = control !== null && control.getAttribute("aria-expanded") === "true";
  let nodes: Element[] = [];

  const owned = control?.getAttribute("aria-controls") ?? control?.getAttribute("aria-owns") ?? null;
  if (owned !== null && owned !== "") {
    const box = document.getElementById(owned);
    if (box !== null) {
      nodes = Array.from(box.querySelectorAll('[role="option"]')).filter(visible);
    }
  }
  if (nodes.length === 0 && control !== null) {
    let node: Element | null = control.parentElement;
    for (let depth = 0; node !== null && depth < 7 && nodes.length === 0; depth++) {
      nodes = Array.from(node.querySelectorAll('[role="option"]')).filter(visible);
      node = node.parentElement;
    }
  }
  if (nodes.length === 0) {
    nodes = Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
  }

  const kept = nodes.slice(0, maxOptions);
  return {
    texts: kept.map((node) => clean(node.textContent)),
    selectors: kept.map((node) => xpathOf(node)),
    count: nodes.length,
    expanded,
  };
}

async function readOpenMenu(page: Page, field: EnumeratedField): Promise<OpenMenu> {
  try {
    const raw = await page.evaluate(
      inPageExpression(
        readOpenMenuInPage,
        `${jsLiteral(field.selector)}, ${MAX_OPTIONS_REPORTED}`
      )
    );
    const failure = inPageError(raw);
    if (failure !== null) {
      console.warn(`[form-fields] could not read an open dropdown's options: ${failure}`);
      return NO_MENU;
    }
    const result = raw as OpenMenu | null;
    if (result === null || !Array.isArray(result.texts)) return NO_MENU;
    return {
      texts: result.texts.map(String),
      selectors: Array.isArray(result.selectors) ? result.selectors.map(String) : [],
      count: typeof result.count === "number" ? result.count : result.texts.length,
      expanded: result.expanded === true,
    };
  } catch {
    return NO_MENU;
  }
}

/**
 * Gets one dropdown's menu open, by trying each rung of its activation ladder
 * until something happens.
 *
 * "Something happened" is two different observations and both count. Options
 * appearing is the obvious one. `aria-expanded="true"` with no options is the
 * other, and it is not a failure: it is a *search* control — Greenhouse's
 * "Location (City)" is one — whose list is a server's answer to a query nobody
 * has typed yet. Treating that as "this control will not open" and clicking
 * further up the ladder would close the thing that had just opened.
 */
async function openMenu(page: Page, field: EnumeratedField): Promise<OpenMenu> {
  let menu = NO_MENU;
  for (const target of field.activateSelectors) {
    menu = await readOpenMenu(page, field);
    if (!menu.expanded && menu.texts.length === 0) {
      await scrollIntoView(page, target);
      try {
        await page.locator(target).click();
      } catch {
        continue;
      }
    }

    const deadline = Date.now() + MENU_ATTEMPT_TIMEOUT_MS;
    menu = await readOpenMenu(page, field);
    while (menu.texts.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(MENU_POLL_MS);
      menu = await readOpenMenu(page, field);
    }
    if (menu.texts.length > 0 || menu.expanded) return menu;
  }
  return menu;
}

/**
 * Brings an element into view before it is clicked.
 *
 * Stagehand's `locator.click()` dispatches at the element's centroid over CDP
 * and does not scroll first, so a control below the fold is a click into the
 * void. Never fatal — a scroll that fails leaves the click to succeed or fail on
 * its own merits.
 */
async function scrollIntoView(page: Page, selector: string): Promise<void> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const path = sel.startsWith("xpath=") ? sel.slice(6) : sel;
    let el = null;
    try {
      el = (path.startsWith("/") || path.startsWith("("))
        ? document.evaluate(path, document, null, 9, null).singleNodeValue
        : document.querySelector(sel);
    } catch { return false; }
    if (!el || !el.scrollIntoView) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    // Not worth a line in any report.
  }
}

/**
 * Scrolls an element into view **only if it is not already there**.
 *
 * Used for menu options, where the unconditional `scrollIntoView` above is
 * actively harmful: scrolling a three-option menu that was already fully on
 * screen moved the page under an open react-select and the following click
 * selected nothing at all — Gender and Race and Ethnicity both came back empty
 * on a run where the value was correct and the option was correctly identified.
 * `block: "nearest"` for the same reason: the least movement that puts the
 * element on screen is the least that can disturb the widget.
 */
async function scrollIfOffscreen(page: Page, selector: string): Promise<void> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const path = sel.startsWith("xpath=") ? sel.slice(6) : sel;
    let el = null;
    try {
      el = (path.startsWith("/") || path.startsWith("("))
        ? document.evaluate(path, document, null, 9, null).singleNodeValue
        : document.querySelector(sel);
    } catch { return false; }
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const h = window.innerHeight || document.documentElement.clientHeight;
    const w = window.innerWidth || document.documentElement.clientWidth;
    if (r.top >= 0 && r.left >= 0 && r.bottom <= h && r.right <= w) return true;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    // Not worth a line in any report.
  }
}

/** Closes whatever menu is open, without pressing anything that could submit. */
async function closeMenu(page: Page): Promise<void> {
  try {
    await page.keyPress("Escape");
  } catch {
    // A menu that will not close costs the next `harvestOptions` an extra read.
  }
}

/**
 * Opens one scripted dropdown and reads what a human would see in it.
 *
 * Deliberately cheap and deliberately fallible: every failure mode — a control
 * that will not open, a menu that never renders, a widget that fetches its
 * options from a server as you type — comes back as "no options known", which
 * the decision layer treats as a reason to ask rather than a reason to guess.
 */
export async function harvestOptions(
  page: Page,
  field: EnumeratedField
): Promise<{ options: string[]; truncated: boolean; opened: boolean }> {
  const menu = await openMenu(page, field);
  await closeMenu(page);
  return {
    options: menu.texts.filter((text) => text !== ""),
    truncated: menu.count > menu.texts.length,
    opened: menu.expanded || menu.texts.length > 0,
  };
}

// ───────────────────────────────────
// Action — one decided value into one control
// ───────────────────────────────────

export type ApplyOutcome = {
  ok: boolean;
  /** What the control reads back afterwards. */
  readBack: string;
  detail: string;
};

/** Reads one control's current value back out of the page. */
export async function readFieldValue(page: Page, field: EnumeratedField): Promise<string> {
  const script = `(() => {
    const sel = ${jsLiteral(field.selector)};
    const path = sel.startsWith("xpath=") ? sel.slice(6) : sel;
    let el = null;
    try {
      el = (path.startsWith("/") || path.startsWith("("))
        ? document.evaluate(path, document, null, 9, null).singleNodeValue
        : document.querySelector(sel);
    } catch { return ""; }
    if (!el) return "";
    const clean = (v) => (v || "").replace(/\\s+/g, " ").trim();
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const opt = el.options[el.selectedIndex];
      return el.value === "" ? "" : clean(opt && opt.textContent);
    }
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "radio" || type === "checkbox") return el.checked ? "checked" : "";
    const role = (el.getAttribute("role") || "").toLowerCase();
    const isCombo = role === "combobox" || el.getAttribute("aria-autocomplete") === "list";
    if (isCombo) {
      let shell = el;
      for (let d = 0; shell && d < 5; d++) {
        const rendered = shell.querySelector('[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]');
        if (rendered) { const t = clean(rendered.textContent); if (t) return t; }
        const mirror = shell.querySelector('input[aria-hidden="true"][tabindex="-1"]');
        if (mirror) { const v = clean(mirror.value); if (v) return v; }
        shell = shell.parentElement;
      }
    }
    return clean(el.value);
  })()`;
  try {
    const value = await page.evaluate(script);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** One element's own visible text, for confirming what is about to be clicked. */
async function readElementText(page: Page, selector: string): Promise<string> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const path = sel.startsWith("xpath=") ? sel.slice(6) : sel;
    let el = null;
    try {
      el = (path.startsWith("/") || path.startsWith("("))
        ? document.evaluate(path, document, null, 9, null).singleNodeValue
        : document.querySelector(sel);
    } catch { return ""; }
    return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "";
  })()`;
  try {
    const text = await page.evaluate(script);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** `checked` for a radio group means "one of its radios is checked". */
async function readRadioGroupValue(page: Page, field: EnumeratedField): Promise<string> {
  for (const [index, selector] of field.optionSelectors.entries()) {
    try {
      if (await page.locator(selector).isChecked()) return field.options[index] ?? "checked";
    } catch {
      // A radio that cannot be read is not a radio that is checked.
    }
  }
  return "";
}

/**
 * Types a value into a single- or multi-line text control and confirms it.
 *
 * `locator.fill` is a structured call carrying the value as an argument — the
 * same property `typeInto` relies on in `stagehand-session.ts`, reached more
 * directly because there is no observation to cache here: the selector came out
 * of the DOM, not out of a model.
 */
async function fillText(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  await scrollIntoView(page, field.selector);
  try {
    await page.locator(field.selector).fill(value);
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not type into the control: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const readBack = await readFieldValue(page, field);
  const matches = normalizeText(readBack) === normalizeText(value);
  return {
    ok: matches,
    readBack,
    detail: matches
      ? "typed and read back identical"
      : `the control now reads ${JSON.stringify(readBack.slice(0, 120))}, which is not what was typed`,
  };
}

/**
 * A native `<select>`: one structured call, one read-back.
 *
 * The visible text is translated to the option's `value` attribute first,
 * because that is what the browser's own selection API takes — and the
 * translation is a lookup in a list read off this same page, not a guess.
 */
async function selectNative(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  const index = field.options.findIndex((option) => normalizeText(option) === normalizeText(value));
  if (index === -1) {
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail: `"${value}" is not one of this dropdown's options`,
    };
  }
  const optionValue = field.optionValues[index] ?? "";
  if (optionValue === "") {
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail: `the option "${value}" carries no value attribute to select it by`,
    };
  }

  await scrollIntoView(page, field.selector);
  try {
    await page.locator(field.selector).selectOption([optionValue]);
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not choose "${value}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const readBack = await readFieldValue(page, field);
  const matches = normalizeText(readBack) === normalizeText(value);
  return {
    ok: matches,
    readBack,
    detail: matches ? `chose "${value}" and read it back` : `the control reads "${readBack}" instead`,
  };
}

/**
 * A scripted dropdown: open it, find the option whose visible text *is* the
 * decided value, click that element.
 *
 * Three things this deliberately does not do. It does not accept a near match —
 * `allowContains` is off by default, and a value that is not on the menu comes
 * back as a failure the caller escalates rather than a best guess clicked into a
 * real employer's form. It does not describe the option to a model to have it
 * found; the option's own DOM node is clicked. And it does not fall back to
 * leaving the typed text in the box, which on a react-select control looks
 * filled and submits empty.
 *
 * `allowContains` is the one exception, for the async "Location (City)" style of
 * control that has no options at all until you type: there the menu is a
 * server's answer to our own query, so accepting an option that *contains* what
 * we asked for ("San Francisco, CA, USA" for "San Francisco") is matching, not
 * guessing — and only when exactly one option contains it.
 */
async function chooseFromMenu(
  page: Page,
  field: EnumeratedField,
  value: string,
  allowContains: boolean
): Promise<ApplyOutcome> {
  // Choosing an option is idempotent — the same option chosen twice is the same
  // form — so one retry is free, and it is worth having: on a live Greenhouse
  // form the click occasionally lands while the widget is still re-rendering
  // from the *previous* field and selects nothing at all. A retry is allowed
  // only when the control came back **empty**; a control holding a *different*
  // value is a real mismatch and is escalated, never clicked at again.
  let outcome = await chooseFromMenuOnce(page, field, value, allowContains);
  if (!outcome.ok && outcome.readBack === "") {
    await closeMenu(page);
    await page.waitForTimeout(400);
    outcome = await chooseFromMenuOnce(page, field, value, allowContains);
  }
  return outcome;
}

async function chooseFromMenuOnce(
  page: Page,
  field: EnumeratedField,
  value: string,
  allowContains: boolean
): Promise<ApplyOutcome> {
  const wanted = normalizeText(value);

  const pick = (menu: OpenMenu): number => {
    const exact = menu.texts.findIndex((text) => normalizeText(text) === wanted);
    if (exact !== -1) return exact;
    if (!allowContains) return -1;
    const matches = menu.texts
      .map((text, index) => ({ text, index }))
      .filter((entry) => normalizeText(entry.text).includes(wanted));
    // Only when it is unambiguous. Two cities that both contain the query is
    // exactly the case where a wrong pick is invisible on the screenshot.
    return matches.length === 1 ? (matches[0]?.index ?? -1) : -1;
  };

  let menu = await openMenu(page, field);
  if (!menu.expanded && menu.texts.length === 0) {
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail: "the dropdown could not be opened",
    };
  }

  /**
   * Narrows the menu by typing the value into it, then waits for the list to
   * settle. The string typed here is one this system decided on — an option it
   * read off this page, or a fact about the candidate — so nothing untrusted is
   * being fed anywhere; it is a search query, and the answer is still only ever
   * chosen from the options that come back.
   */
  const narrow = async (): Promise<number> => {
    try {
      await page.locator(field.selector).fill(value);
    } catch {
      // Not every combobox accepts typing. The menu read below still stands.
      return pick(menu);
    }
    const deadline = Date.now() + MENU_SEARCH_TIMEOUT_MS;
    menu = await readOpenMenu(page, field);
    let found = pick(menu);
    while (found === -1 && Date.now() < deadline) {
      await page.waitForTimeout(MENU_POLL_MS);
      menu = await readOpenMenu(page, field);
      found = pick(menu);
    }
    return found;
  };

  let index =
    menu.count > MAX_UNFILTERED_MENU_OPTIONS ? await narrow() : pick(menu);
  // Either the list was short and the value is not on it, or it is a search
  // control that had nothing in it until it was asked a question.
  if (index === -1) index = await narrow();

  if (index === -1) {
    await closeMenu(page);
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail:
        menu.texts.length === 0
          ? "the dropdown offered no options to choose from"
          : `"${value}" is not one of this dropdown's options (${menu.texts
              .slice(0, 8)
              .map((text) => JSON.stringify(text))
              .join(", ")}${menu.count > 8 ? ", …" : ""})`,
    };
  }

  const optionSelector = menu.selectors[index];
  const chosen = menu.texts[index] ?? value;
  if (optionSelector === undefined) {
    await closeMenu(page);
    return { ok: false, readBack: "", detail: "the matched option had no addressable element" };
  }

  // Brought on screen if it is not already, then re-read, then clicked — in
  // that order. A click lands where the option is *painted*, so an option
  // scrolled out of view is a click on something else; and menus re-render
  // (react-select rebuilds its whole list on every keystroke), so "the option
  // at position 4" is only the right thing to click while position 4 is still
  // the option that was chosen. The re-read is what proves both.
  await scrollIfOffscreen(page, optionSelector);
  const stillReads = await readElementText(page, optionSelector);
  if (normalizeText(stillReads) !== normalizeText(chosen)) {
    await closeMenu(page);
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail:
        `the option to click moved between reading the menu and clicking it — that position ` +
        `now reads ${JSON.stringify(stillReads.slice(0, 80))} rather than ` +
        `${JSON.stringify(chosen.slice(0, 80))}. Nothing was chosen.`,
    };
  }

  try {
    await page.locator(optionSelector).click();
  } catch (err) {
    await closeMenu(page);
    return {
      ok: false,
      readBack: "",
      detail: `could not click the option: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // A widget that re-renders its selection asynchronously reads empty for a
  // moment after the click. Polled rather than slept on, so the common case
  // costs one read.
  let readBack = await readFieldValue(page, field);
  const settleBy = Date.now() + MENU_SETTLE_TIMEOUT_MS;
  while (readBack === "" && Date.now() < settleBy) {
    await page.waitForTimeout(MENU_POLL_MS);
    readBack = await readFieldValue(page, field);
  }
  const shown = normalizeText(readBack);
  const wantedOption = normalizeText(chosen);
  if (shown === wantedOption) {
    return { ok: true, readBack, detail: `chose "${chosen}" and read it back` };
  }
  // Some widgets display an abbreviation of what was chosen rather than the
  // option's own words — Greenhouse's phone-country picker shows a flag and
  // "+1" for an option labelled "United States +1". The control went from empty
  // to showing part of the option whose element we had just re-read and
  // clicked, which is as much as this can honestly confirm, and it is said out
  // loud in the report rather than reported as an exact match.
  if (shown !== "" && (wantedOption.includes(shown) || shown.includes(wantedOption))) {
    return {
      ok: true,
      readBack,
      detail:
        `chose "${chosen}"; the control displays ${JSON.stringify(readBack.slice(0, 60))}, which ` +
        `is the abbreviated form of that option rather than its full wording`,
    };
  }
  return {
    ok: false,
    readBack,
    detail: `clicked "${chosen}" but the control reads ${JSON.stringify(readBack.slice(0, 120))}`,
  };
}

/** One radio out of its group, chosen by the option text the caller decided on. */
async function chooseRadio(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  const wanted = normalizeText(value);
  const index = field.options.findIndex((option) => normalizeText(option) === wanted);
  const selector = index === -1 ? undefined : field.optionSelectors[index];
  if (selector === undefined) {
    return {
      ok: false,
      readBack: await readRadioGroupValue(page, field),
      detail: `"${value}" is not one of this group's choices`,
    };
  }
  await scrollIntoView(page, selector);
  try {
    await page.locator(selector).click();
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not click the choice: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const readBack = await readRadioGroupValue(page, field);
  const matches = normalizeText(readBack) === wanted;
  return {
    ok: matches,
    readBack,
    detail: matches ? `chose "${value}"` : `the group now reads "${readBack}"`,
  };
}

/** A single checkbox. `value` is read as a yes/no; anything else is a refusal. */
async function setCheckbox(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  const wanted = normalizeText(value);
  const yes = ["yes", "true", "checked", "check", "on", "1", "agree", "i agree"].includes(wanted);
  const no = ["no", "false", "unchecked", "uncheck", "off", "0"].includes(wanted);
  if (!yes && !no) {
    return { ok: false, readBack: "", detail: `"${value}" is not a yes or a no for a checkbox` };
  }

  await scrollIntoView(page, field.selector);
  let checked: boolean;
  try {
    checked = await page.locator(field.selector).isChecked();
    if (checked !== yes) await page.locator(field.selector).click();
    checked = await page.locator(field.selector).isChecked();
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not set the checkbox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: checked === yes,
    readBack: checked ? "checked" : "",
    detail: checked === yes ? `set to ${yes ? "checked" : "unchecked"}` : "the checkbox did not change",
  };
}

/**
 * Puts one value into one control, by the only mechanism that control has.
 *
 * There is no model on this path and no natural-language instruction anywhere in
 * it: the selector came from `enumerateFormFields`, the value came from the
 * decision layer, and what happens between them is a `fill`, a `selectOption` or
 * a `click` on an element addressed by selector.
 */
export async function applyFieldValue(
  page: Page,
  field: EnumeratedField,
  value: string,
  options: { allowContains?: boolean } = {}
): Promise<ApplyOutcome> {
  switch (field.kind) {
    case "text":
      return await fillText(page, field, value);
    case "textarea":
      return await fillText(page, field, value);
    case "select":
      return await selectNative(page, field, value);
    case "combobox":
      return await chooseFromMenu(page, field, value, options.allowContains === true);
    case "radio":
      return await chooseRadio(page, field, value);
    case "checkbox":
      return await setCheckbox(page, field, value);
    default:
      return {
        ok: false,
        readBack: "",
        detail: `a ${field.kind} control is not something this fills`,
      };
  }
}
