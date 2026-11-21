// A header picker: a button showing the current choice that opens a filterable list (a popover; a bottom sheet on phones).
// Focus stays in the filter field while it is open (combobox + listbox); the rows are never focused themselves.
import { el } from './core.js';

const SEARCH_FROM = 8; // the filter field shows from this many rows; with fewer it appears once something is typed
const phone = matchMedia('(max-width: 900px)');
let n = 0;

/**
 * @typedef {{ value: string, name: string, sub?: string, state?: string }} PickItem state colours the dot: needs, working or idle
 * @param {HTMLButtonElement} btn its value is the current choice; its parent (.pp) gets the list
 * @param {{ onPick: (value: string) => void, actions?: [string, () => void][], placeholder?: string }} opts actions are pinned under the list
 */
export function picker(btn, { onPick, actions = [], placeholder = 'Filter…' }) {
    const wrap = /** @type {HTMLElement} */ (btn.parentElement), id = `pp${n++}`;
    const pop = el('div', 'pp-pop'), panel = el('div', 'pp-panel'), search = /** @type {HTMLInputElement} */ (el('input', 'pp-search'));
    const list = el('div', 'pp-list'), none = el('div', 'pp-none', 'Nothing matches'), foot = el('div', 'pp-foot');
    const dot = el('span', 'pp-dot'), name = el('span', 'pp-name');
    /** @type {Map<string, HTMLElement>} */
    const rows = new Map();
    let last = '', active = '', made = 0;

    pop.hidden = none.hidden = true;
    list.id = `${id}-list`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', btn.getAttribute('aria-label') ?? '');
    list.tabIndex = -1;
    search.type = 'text';
    search.placeholder = placeholder;
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-label', placeholder);
    search.setAttribute('aria-controls', list.id);
    search.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-autocomplete', 'list');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', list.id);
    btn.replaceChildren(dot, name, el('span', 'pp-chev'));
    foot.append(...actions.map(([label, run]) => {
        const b = el('button', null, label);
        b.type = 'button';
        b.onclick = () => {
            close(false);
            run();
        };
        return b;
    }));
    foot.hidden = !actions.length;
    panel.append(search, list, none, foot);
    pop.append(panel);
    wrap.append(pop);

    const isOpen = () => !pop.hidden;
    const shown = () => [...rows.values()].filter(r => !r.hidden);
    /** @param {string} value */
    function setActive(value, scroll = true) {
        active = value;
        for (const [v, r] of rows) {
            r.classList.toggle('act', v === value);
        }
        const r = rows.get(value);
        search.setAttribute('aria-activedescendant', r?.id ?? '');
        if (scroll) {
            r?.scrollIntoView({ block: 'nearest' });
        }
    }
    function filter() {
        const q = search.value.trim().toLowerCase();
        for (const r of rows.values()) {
            r.hidden = !!q && !(r.dataset.name ?? '').toLowerCase().includes(q);
        }
        const vis = shown();
        none.hidden = vis.length > 0;
        if (!vis.includes(/** @type {HTMLElement} */ (rows.get(active)))) {
            setActive(vis[0]?.dataset.value ?? '');
        }
    }
    function open() {
        if (isOpen()) {
            return;
        }
        search.value = '';
        pop.hidden = false;
        wrap.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        filter();
        setActive(btn.value);
        // a phone's keyboard would cover the sheet: it comes up only when the filter field is tapped
        (phone.matches ? list : search).focus({ preventScroll: true });
    }
    /** @param {boolean} refocus back to the button (not when focus already moved on) */
    function close(refocus) {
        if (!isOpen()) {
            return;
        }
        pop.hidden = true;
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        if (refocus) {
            btn.focus({ preventScroll: true });
        }
    }
    /** @param {string} value */
    function pick(value) {
        close(true);
        onPick(value);
    }

    btn.addEventListener('click', () => (isOpen() ? close(true) : open()));
    btn.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            open();
        }
    });
    search.addEventListener('input', filter);
    pop.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close(true);
            return;
        }
        if (foot.contains(/** @type {Node} */ (e.target))) {
            return; // the pinned buttons keep their own Enter and Space
        }
        const vis = shown(), at = vis.indexOf(/** @type {HTMLElement} */ (rows.get(active)));
        const to = { ArrowDown: (at + 1) % vis.length, ArrowUp: (at <= 0 ? vis.length : at) - 1, Home: 0, End: vis.length - 1 }[e.key];
        if (e.key === 'Enter') {
            e.preventDefault();
            if (rows.has(active)) {
                pick(active);
            }
        } else if (to != null && vis.length && !((e.key === 'Home' || e.key === 'End') && search.value)) {
            e.preventDefault();
            setActive(vis[to].dataset.value ?? '');
        }
    });
    const rowAt = e => /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('.pp-row'));
    list.addEventListener('mousedown', e => e.preventDefault()); // the filter field keeps the focus
    list.addEventListener('mousemove', e => {
        const r = rowAt(e);
        if (r && r.dataset.value !== active) {
            setActive(r.dataset.value ?? '', false);
        }
    });
    list.addEventListener('click', e => {
        const r = rowAt(e);
        if (r) {
            pick(r.dataset.value ?? '');
        }
    });
    // outside: a click elsewhere (on phones the dimmed backdrop, which is pop itself), or focus moving out with Tab
    document.addEventListener('click', e => {
        if (isOpen() && (e.target === pop || !e.composedPath().includes(wrap))) {
            close(false);
        }
    });
    wrap.addEventListener('focusout', e => {
        if (e.relatedTarget instanceof Node && !wrap.contains(e.relatedTarget)) {
            close(false);
        }
    });

    return {
        open,
        isOpen,
        // Redraws only what changed, keeping the row nodes, so an open list keeps its highlighted row across the page's polls.
        /** @param {PickItem[]} items @param {string} value */
        update(items, value) {
            const sig = JSON.stringify([items, value]);
            if (sig === last) {
                return;
            }
            last = sig;
            const set = (/** @type {Element | null} */ e, /** @type {string} */ t) => {
                if (e && e.textContent !== t) {
                    e.textContent = t;
                }
            };
            const order = items.map(it => {
                let r = rows.get(it.value);
                if (!r) {
                    r = el('div', 'pp-row');
                    r.id = `${id}-${made++}`;
                    r.setAttribute('role', 'option');
                    r.dataset.value = it.value;
                    const text = el('span', 'pp-text');
                    text.append(el('span', 'pp-name'), el('small'));
                    r.append(el('span', 'pp-dot'), text, el('span', 'pp-check'));
                    rows.set(it.value, r);
                }
                r.dataset.name = it.name;
                r.dataset.state = it.state ?? '';
                r.setAttribute('aria-selected', String(it.value === value));
                set(r.querySelector('.pp-name'), it.name);
                set(r.querySelector('small'), it.sub ?? '');
                return r;
            });
            for (const [v, r] of rows) {
                if (!order.includes(r)) {
                    rows.delete(v);
                }
            }
            if (order.length !== list.children.length || order.some((r, i) => list.children[i] !== r)) {
                list.replaceChildren(...order);
            }
            panel.classList.toggle('few', items.length < SEARCH_FROM);
            const cur = items.find(it => it.value === value);
            btn.value = value;
            btn.dataset.state = cur?.state ?? '';
            set(name, cur?.name ?? '');
            if (isOpen()) {
                filter();
                setActive(active, false);
            }
        }
    };
}
