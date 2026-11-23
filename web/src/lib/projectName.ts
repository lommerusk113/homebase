/** Mirrors the server's rule (server/newproject.mjs, which checks again). @returns the problem, or '' */
export const nameError = (n: string): string => (!n ? '' : n.length > 100 ? 'At most 100 characters' : n.startsWith('.') ? "Can't start with a dot" : /^[A-Za-z0-9._-]+$/.test(n) ? '' : 'Use letters, digits, ".", "_" and "-"');
