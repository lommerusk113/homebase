// Small text helpers: plain-word versions of commands, markdown and server errors.

// A shell command in plain words for a row's "Now:" line: "running browser tests", "editing app.js", "waiting for browser tests".
// ponytail: regexes over the whole command text, first match wins; an unknown command falls back to "running <first word>"
const THINGS: [RegExp, string][] = [[/run\.mjs/, 'browser tests'], [/test\.mjs|\b(?:vitest|jest)\b|npm (?:run )?test/, 'unit tests'], [/check-types|\btsc\b/, 'type checks']];

export function plainCommand(command?: string): string {
    const cmd = String(command ?? '').trim().replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
    const thing = THINGS.find(([re]) => re.test(cmd))?.[1];
    const file = (verb: string) => {
        const f = cmd.split(/\s+/).findLast(t => /^[\w@./~-]+\.\w+$/.test(t));
        return `${verb} ${f ? f.split('/').pop() : 'a file'}`;
    };
    const git = cmd.match(/\bgit\s+(rebase|merge|commit|push)\b/)?.[1] as 'rebase' | 'merge' | 'commit' | 'push' | undefined;
    if (/^(?:while|until|sleep)\b|\bsleep\b|\bpgrep\b/.test(cmd)) {
        return thing ? `waiting for ${thing}` : 'waiting';
    }
    if (git) {
        return { rebase: 'rebasing', merge: 'merging', commit: 'committing', push: 'pushing' }[git];
    }
    if (thing) {
        return thing === 'type checks' ? 'type-checking' : `running ${thing}`;
    }
    const [first = '', next = ''] = cmd.split(/\s+/), bin = first.split('/').pop()?.replace(/\d+$/, '') ?? '';
    return /screenshot/i.test(cmd) ? 'taking screenshots'
        : bin === 'sed' ? file('editing')
        : /^(?:cat|head|tail|less|bat)$/.test(bin) ? file('reading')
        : /^(?:grep|rg|ag)$/.test(bin) || /\bgit\s+grep\b/.test(cmd) ? 'searching'
        : bin === 'glab' ? 'calling GitLab' : bin === 'gh' ? 'calling GitHub' : bin === 'curl' ? 'calling an API'
        : /^(?:zsh|bash|sh)$/.test(bin) && next ? `running ${next.split('/').pop()}`
        : `running ${bin}`;
}

/** Markdown marks and runs of whitespace dropped. */
export const plain = (t?: string | null): string => (t || '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();

// plain() would also drop the # of "#2225"; only markdown emphasis and leading heading marks go here
/** The start of a text (n characters at most, cut at a word) without markdown emphasis. */
export const excerpt = (t: string | null | undefined, n = 80): string => {
    const p = (t || '').replace(/[*_`>]+|^\s*#+\s+/g, '').replace(/\s+/g, ' ').trim();
    return p.length > n ? p.slice(0, n).replace(/\s+\S*$/, '') + '…' : p;
};

/** First sentence of a message without a TLDR, capped near 200 chars, with dangling ** or ` closed. */
export function lead(text?: string | null): string {
    const line = (text || '').split('\n').map(l => l.trim()).find(l => l && !/^(```|\||---|<)/.test(l)) || '';
    const s = line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, '');
    let cut = s.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? s;
    const long = cut.length > 200;
    if (long) {
        cut = cut.slice(0, 200).replace(/\s+\S*$/, '');
    }
    if ((cut.match(/\*\*/g)?.length ?? 0) % 2) {
        cut += '**';
    }
    if ((cut.match(/`/g)?.length ?? 0) % 2) {
        cut += '`';
    }
    return long ? cut + '…' : cut;
}

// Plain sentences for the raw server and tmux errors the chat can show; anything else passes through.
const FRIENDLY: [RegExp, string][] = [
    [/^busy$/, "Claude is busy; try again when it's idle"],
    [/^unknown session/, 'That session is gone. Pick another one from the list.'],
    [/^bad tmux name/, "This chat's terminal name isn't valid. Reload the page and try again."],
    [/ENOENT/, "tmux isn't installed"],
    [/Command failed: tmux|no server running|can't find (session|pane)|no current (session|target)/i, "Couldn't reach this chat's terminal. It may have ended; try Restart chat."]
];
export const friendly = (msg: string): string => FRIENDLY.find(([re]) => re.test(msg))?.[1] ?? msg;

// What the ask card showed, as a short FNV-1a hash of the question and the command or diff: sent with an answer, so the
// server (startup.mjs answerStartup, which imports this) approves only that exact prompt and never one that replaced it.
export const seenHash = (q: { question: string, detail?: string }): string => {
    let h = 0x811c9dc5;
    for (const c of `${q.question}\n${q.detail ?? ''}`) {
        h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193);
    }

    return (h >>> 0).toString(36);
};
