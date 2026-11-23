// Ages against the server's clock.

// The server's clock, for ages of its timestamps: the page's own may be off (a phone, a manual change).
let skew = 0;

/** Takes each poll's Date header; under a minute apart is network and rounding, not skew, and no header means no correction. */
export const syncClock = (date: string | null): void => {
    const d = Date.parse(date ?? '') - Date.now();
    skew = Math.abs(d) > 60_000 ? d : 0;
};

export const serverNow = (): number => Date.now() + skew;

/** "now", "5m", "3h" or "2d" since ms. */
export const ago = (ms: number): string => {
    const s = (serverNow() - ms) / 1000;
    return s < 60 ? 'now' : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d`;
};

/** Whole minutes as "45m" / "1h" / "1h20m". */
export const hoursMinutes = (m: number): string => (m < 60 ? `${m}m` : `${m / 60 | 0}h${m % 60 ? m % 60 + 'm' : ''}`);
