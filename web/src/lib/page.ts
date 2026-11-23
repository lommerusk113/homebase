// The few things an island does to the page outside itself.

/** Says text to screen readers through the page's one live region; unchanged text is not repeated. */
export function announce(text: string): void {
    const live = document.getElementById('announce');
    if (live && live.textContent !== text) {
        live.textContent = text;
    }
}

/** A file as a data: URL, as the CSP allows no blob: images. */
export const dataUrl = (blob: Blob) => new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
});
