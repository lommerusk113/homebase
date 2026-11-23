// When a chat's context should be compacted.

/** /compact only runs on an idle Claude: no open turn, nothing asking (the server refuses otherwise). */
export const canCompact = (s: Session): boolean => s.status !== 'working' && !s.asking;

// Compact thresholds are absolute tokens, so a 1M window compacts as early as a 200k one: nudge at 70k, auto at 100k,
// as a percent of the session's window (1M when the dump doesn't say; never above 90%).
// Auto-compact: idle for 2 min, 100k tokens of context used, no helpers running, and not tried for an hour (lastAt: when this page last sent it for this session).
export const AUTO_COMPACT = { nudgeTokens: 70_000, tokens: 100_000, windowTokens: 1_000_000, idleMs: 2 * 60_000, everyMs: 3600_000 };

export const tokenPercent = (tokens: number, s: Pick<Session, 'contextSize'>): number => Math.min(90, tokens / (s.contextSize || AUTO_COMPACT.windowTokens) * 100);

export const compactNudgeDue = (s: Session): boolean => (s.context ?? 0) >= tokenPercent(AUTO_COMPACT.nudgeTokens, s);

export const autoCompactDue = (s: Session, now: number, lastAt: number): boolean => canCompact(s)
    && !s.subagents?.running
    && (s.context ?? 0) >= tokenPercent(AUTO_COMPACT.tokens, s)
    && now - (s.lastActivity ?? s.updated) >= AUTO_COMPACT.idleMs
    && now - lastAt >= AUTO_COMPACT.everyMs;
