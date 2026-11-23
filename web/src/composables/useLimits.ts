import { computed, ref, shallowRef } from 'vue';
import { api, ago, hooks, limitView, runOutIn } from 'old/core.js';

const PACE_EVERY_MS = 60_000;
const PACE_SAMPLES = 8;

const limits = shallowRef<Limits | null>(null);
const pace = ref<number | null>(null);
let samples: [number, number][] = [];
let windowReset = 0;

// The poll calls this: the dump's rate limits, and the pace of the 5-hour window (a sample a minute, the last 8, reset by a new window).
hooks.refreshLimits = async () => {

    let l: Limits | null = null;
    try {
        l = await api('/api/limits').then(r => r.json());
    } catch {}
    limits.value = l;

    const f = l?.fiveHour, now = Date.now();
    if (f?.resetsAt !== windowReset) {
        samples = [];
        windowReset = f?.resetsAt ?? 0;
    }
    if (f && (!samples.length || now - samples[samples.length - 1][0] >= PACE_EVERY_MS)) {
        samples = [...samples, [now, f.used] as [number, number]].slice(-PACE_SAMPLES);
    }
    pace.value = f ? runOutIn(samples, f.resetsAt, now) : null;
};

/** "Session ▬ 70%   Week ▬ 63%": the rate limit windows as the strip shows them, with minutes until the 5-hour one is empty. */
export function useLimits() {

    const windows = computed(() => [limits.value?.fiveHour, limits.value?.sevenDay]
        .map((w, week) => w && limitView(week, w))
        .filter((v): v is ReturnType<typeof limitView> => Boolean(v)));
    const updated = computed(() => {
        const a = limits.value?.updated && ago(limits.value.updated);

        return !a ? '' : a === 'now' ? 'Updated just now' : `Updated ${a} ago`;
    });

    return { windows, updated, pace };
}
