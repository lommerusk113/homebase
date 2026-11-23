// The Changes view's pure parts: no Vue and no imports, so tests/unit/diff.mjs imports this file as it is.

/**
 * A unified diff as rows: h (hunk header), + (added), - (removed), ' ' (context) and m (a note such as "No newline at
 * end of file"), with the old and new line numbers. The file header above the first hunk is dropped.
 */
export function parseDiff(text: string): DiffRow[] {

    const rows: DiffRow[] = [];
    let o = 0, n = 0, inHunk = false;
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }

    for (const line of lines) {
        const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) {
            o = Number(h[1]);
            n = Number(h[2]);
            inHunk = true;
            rows.push({ t: 'h', text: line });
        } else if (!inHunk) {
            continue;
        } else if (line[0] === '+') {
            rows.push({ t: '+', n: n++, text: line.slice(1) });
        } else if (line[0] === '-') {
            rows.push({ t: '-', o: o++, text: line.slice(1) });
        } else if (line[0] === '\\') {
            rows.push({ t: 'm', text: line.slice(2) });
        } else {
            rows.push({ t: ' ', o: o++, n: n++, text: line.slice(1) });
        }
    }

    return rows;
}

/** An untracked file: every line is new. */
export function addedRows(text: string): DiffRow[] {

    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }

    return lines.map((line, i) => ({ t: '+', n: i + 1, text: line }));
}

/** Files (a path counted once) and added/removed lines over both groups. */
export function diffTotals(v: DiffView) {

    const all = [...v.uncommitted ?? [], ...v.committed ?? []];

    return { files: new Set(all.map(f => f.path)).size, add: all.reduce((n, f) => n + (f.add ?? 0), 0), del: all.reduce((n, f) => n + (f.del ?? 0), 0) };
}
