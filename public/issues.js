// The board's two views: Work and Issues. The Issues tab's logic is web/src/lib/issues.ts, the tab itself the Issues island
// (web/src/islands/Issues.vue) drawn from useIssues.ts.
import { $, store, hooks } from './core.js';

// The board's two views: Work (the item list) and Issues, switched by the header's segmented control (#tabs).
// 1 and 2 pick one, t swaps (keys.js); the choice survives reloads.
/** @param {string | null} tab */
export function showTab(tab) {
    tab = tab === 'issues' ? tab : 'work';
    store.set('tab', tab);
    $('tabs').dataset.tab = tab; // moves the selected segment's thumb (styles.css .seg)
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#tabs button'))) {
        b.setAttribute('aria-selected', String(b.dataset.tab === tab));
        b.tabIndex = b.dataset.tab === tab ? 0 : -1;
    }
    $('masters').hidden = tab !== 'work';
    $('issues').hidden = tab !== 'issues';
}
export const activeTab = () => ($('issues').hidden ? 'work' : 'issues');

// Esc in the Issues tab folds the open card (the Issues island, useIssues); false when there was none.
export const collapseIssue = () => hooks.collapseIssue?.() ?? false;
