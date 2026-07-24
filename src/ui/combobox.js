// @ts-check
/**
 * searchable combobox — shared control for the record facet filters and the
 * graph tag filter. comboboxHtml() renders the closed control; wireCombobox()
 * attaches behavior. Committing a value writes the hidden [data-facet] input
 * and fires a synthetic "change" on it, so delegated facet handlers keep
 * working unchanged; callers without one pass an onChange callback instead.
 */

/** @param {string} s */
const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * @param {string} name facet key — used for data-facet, aria labels, placeholder
 * @param {string} cur committed value ("" = all)
 */
export function comboboxHtml(name, cur) {
  const n = esc(name);
  return `
    <div class="combo" data-combo="${n}">
      <input type="hidden" data-facet="${n}" value="${esc(cur)}" />
      <input class="combo-input" type="text" role="combobox" aria-expanded="false"
        aria-autocomplete="list" aria-controls="combo-list-${n}" aria-label="${n}"
        placeholder="${n}: all" value="${esc(cur)}" autocomplete="off" spellcheck="false" />
      <button class="combo-clear" type="button" aria-label="clear ${n}" tabindex="-1" ${cur ? "" : "hidden"}>×</button>
      <div class="combo-list" id="combo-list-${n}" role="listbox" hidden></div>
    </div>`;
}

/**
 * @param {HTMLElement} root the .combo element rendered by comboboxHtml
 * @param {[string, number][]} options [value, count] pairs, already ranked
 * @param {(value: string) => void} [onChange] called after commit, in addition
 *   to the synthetic "change" dispatched on the hidden input
 */
export function wireCombobox(root, options, onChange) {
  const name = root.getAttribute("data-combo") ?? "";
  const hidden = /** @type {HTMLInputElement} */ (root.querySelector("input[type=hidden]"));
  const input = /** @type {HTMLInputElement} */ (root.querySelector(".combo-input"));
  const clear = /** @type {HTMLButtonElement} */ (root.querySelector(".combo-clear"));
  const list = /** @type {HTMLElement} */ (root.querySelector(".combo-list"));

  /** @type {{ value: string, label: string, count: number | null }[]} */
  let visible = [];
  let activeIdx = 0;

  const isOpen = () => !list.hidden;

  /** @param {string} filter */
  const renderList = (filter) => {
    const q = filter.trim().toLowerCase();
    const matches = q ? options.filter(([v]) => v.toLowerCase().includes(q)) : options;
    visible = q
      ? matches.map(([v, n]) => ({ value: v, label: v, count: n }))
      : [{ value: "", label: `${name}: all`, count: /** @type {number | null} */ (null) },
         ...matches.map(([v, n]) => ({ value: v, label: v, count: n }))];
    list.innerHTML = visible.length
      ? visible
          .map(
            (o, i) =>
              `<div class="combo-opt" role="option" id="combo-opt-${esc(name)}-${i}" data-idx="${i}"
                 aria-selected="${o.value === hidden.value}">${esc(o.label)}${
                   o.count === null ? "" : `<span class="n">${o.count}</span>`
                 }</div>`,
          )
          .join("")
      : `<div class="combo-empty">no match</div>`;
    activeIdx = 0;
    if (!q) {
      const cur = visible.findIndex((o) => o.value === hidden.value);
      if (cur >= 0) activeIdx = cur;
    }
    markActive();
  };

  const markActive = () => {
    list.querySelectorAll(".combo-opt").forEach((el, i) => el.classList.toggle("is-active", i === activeIdx));
    const active = list.querySelector(".combo-opt.is-active");
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };

  const open = () => {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    renderList("");
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const revert = () => {
    input.value = hidden.value;
  };

  /** @param {string} value */
  const commit = (value) => {
    hidden.value = value;
    input.value = value;
    clear.hidden = !value;
    close();
    hidden.dispatchEvent(new Event("change"));
    onChange?.(value);
  };

  input.addEventListener("focus", () => {
    if (!isOpen()) open();
    input.select();
  });
  input.addEventListener("click", () => {
    if (!isOpen()) open();
  });
  input.addEventListener("input", () => {
    if (!isOpen()) {
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    renderList(input.value);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!isOpen()) return open();
      if (!visible.length) return;
      const d = ev.key === "ArrowDown" ? 1 : -1;
      activeIdx = (activeIdx + d + visible.length) % visible.length;
      markActive();
    } else if (ev.key === "Enter") {
      if (isOpen() && visible[activeIdx]) {
        ev.preventDefault();
        commit(visible[activeIdx].value);
      }
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      revert();
      close();
    } else if (ev.key === "Tab") {
      revert();
      close();
    }
  });

  // pointerdown (not click) so selection wins the race against input blur
  list.addEventListener("pointerdown", (ev) => {
    const opt = ev.target instanceof Element ? ev.target.closest(".combo-opt") : null;
    if (!opt) return;
    ev.preventDefault();
    commit(visible[Number(opt.getAttribute("data-idx"))].value);
  });
  list.addEventListener("mouseover", (ev) => {
    const opt = ev.target instanceof Element ? ev.target.closest(".combo-opt") : null;
    if (!opt) return;
    activeIdx = Number(opt.getAttribute("data-idx"));
    markActive();
  });

  clear.addEventListener("click", () => commit(""));

  root.addEventListener("focusout", (ev) => {
    const to = /** @type {FocusEvent} */ (ev).relatedTarget;
    if (to instanceof Node && root.contains(to)) return;
    revert();
    close();
  });
}
