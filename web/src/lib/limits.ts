// The rate-limit strip's numbers.
import { hoursMinutes } from './time.ts';

/** Rate-limit window -> % left and time to reset, as Contado's footer shows it: "70%" and "1h20m" / "4d22h" / "45m". */
export const limitLeft = (w: LimitWindow, now = Date.now()) => {

    const m = Math.max(0, w.resetsAt - now) / 60000 | 0, d = m / 1440 | 0, h = m % 1440 / 60 | 0;
    const until = d ? `${d}d${h ? h + 'h' : ''}` : hoursMinutes(m);

    return { left: Math.max(0, Math.min(100, Math.round(100 - w.used))), until };
};

/** Minutes until the window is empty at the pace of its samples [[time, used%]], or null when that is after the reset, the pace is flat or the samples span under 2 minutes. */
export const runOutIn = (samples: [number, number][], resetsAt: number, now = Date.now()): number | null => {
    const [t0, u0] = samples[0] ?? [0, 0], [t1, u1] = samples.at(-1) ?? [0, 0];
    if (samples.length < 2 || t1 - t0 < 120_000 || u1 <= u0) {
        return null;
    }
    const min = (100 - u1) / ((u1 - u0) / (t1 - t0)) / 60000;

    return now + min * 60000 < resetsAt ? Math.max(1, Math.round(min)) : null;
};

/** Limits strip item: "Session 70%" at a glance, details in the tooltip; the countdown shows inline only once under 20% is left. */
export const limitView = (week: boolean | number, w: LimitWindow, now = Date.now()) => {
    const { left, until } = limitLeft(w, now), at = new Date(w.resetsAt), pad = (n: number) => String(n).padStart(2, '0');
    const when = `${week ? at.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' : ''}${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return {
        label: week ? 'Week' : 'Session', left, when,
        text: `${left}%${left < 20 ? ` · resets ${until}` : ''}`,
        tip: `${left}% left of your ${week ? 'weekly' : '5-hour'} limit · resets in ${until} (${when})`,
    };
};
