let n = 0;

/** A page-unique element id: for aria-controls and <wa-tooltip for>, which need one across every island. */
export const uid = (prefix: string) => `${prefix}-${++n}`;
