import { computed } from 'vue';
import { ago, inView } from 'old/core.js';
import { oldState } from '@/old';

const STALE_MS = 75_000; // ponytail: the server rereads an MR after 60 s, so a minute plus a few polls is what "old" starts at

/**
 * One line per forge the board can't reach: what is wrong and what to do, with the last good data kept below it. Else,
 * once the MR states shown are older than a minute, how old they are.
 */
export function useForgeNotes() {

    const notes = computed(() => {
        const by = new Map<string, { f: ForgeStatus; projects: string[]; oldest: number }>();
        const forges = new Map(oldState.value.sessions.filter(inView).flatMap(s => (s.forge ? [[s.project, s.forge] as const] : [])));
        for (const [project, f] of forges) {
            const key = `${f.name}:${f.problem ?? ''}`, g = by.get(key) ?? { f, projects: [], oldest: Infinity };
            g.projects.push(project);
            g.oldest = Math.min(g.oldest, f.checkedAt ?? Infinity);
            by.set(key, g);
        }

        return [...by.values()].flatMap(({ f, projects, oldest }) => {
            const old = Number.isFinite(oldest) && Date.now() - oldest > STALE_MS ? ago(oldest) : null;
            if (!f.problem && !old) {
                return [];
            }
            const where = oldState.value.project === 'all' ? ` (${projects.join(', ')})` : '';

            return [{
                err: !!f.problem,
                text: f.problem ? `Can't reach ${f.name}${where}: ${f.help}${old ? ` Showing what it was ${old} ago.` : ''}` : `${f.name} data${where} is from ${old} ago`
            }];
        });
    });

    return { notes };
}
