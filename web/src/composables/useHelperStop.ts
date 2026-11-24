import { api } from 'old/core.js';
import { renderBoard } from 'old/list.js';
import { useNotice } from './useNotice';

/** The Stop button of a helper that runs in its own chat (server/helpers.mjs): closes its tmux and worktree, as
 *  `homebase helper stop` does. While it works the user confirms first. */
export function useHelperStop() {

    const canStop = (x: WorkItem) => !!x.helperSession && !x.helperClosed;
    /** where the user can watch it outside Homebase */
    const attachHint = (x: WorkItem) => `Stop this helper · tmux attach -t cc-${x.helperSession!.slice(0, 8)}`;

    async function stop(x: WorkItem) {

        if (x.agentStatus === 'running' && !window.confirm(`Stop “${x.title}”? It is still working.`)) {
            return;
        }
        const r = await api(`/api/helpers/stop?id=${encodeURIComponent(x.helperSession!)}`, { method: 'POST' }).catch(() => null);
        if (!r?.ok) {
            useNotice().showError(r ? await r.text() : 'Couldn’t reach Homebase to stop this helper');
            return;
        }
        renderBoard();
    }

    return { canStop, attachHint, stop };
}
