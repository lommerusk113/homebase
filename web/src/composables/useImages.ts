import { api } from 'old/core.js';

// Upload names in a message's "[Image: …]" lines (only the names /api/upload makes).
const IMAGE_LINE = /^\[Image: \/[^\]\n]*\/([0-9a-f-]{36}\.(?:png|jpe?g|gif|webp))\]$/gm;

// data: URLs, as the CSP allows no blob: images. /api/upload/<name> needs the token header, so no plain <img src>.
const dataUrl = (blob: Blob) => new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
});
// ponytail: every image the chat showed stays in memory until reload; fine for a session's worth of screenshots
const images = new Map<string, Promise<string>>();

/** The images a sent message carries: their names, the text without them, and each one's data: URL ('' when it can't be read). */
export function useImages() {

    const names = (text: string) => [...(text || '').matchAll(IMAGE_LINE)].map(m => m[1]);
    // the bubble shows the pictures instead of their paths
    const withoutLines = (text: string) => (text || '').replace(IMAGE_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
    const url = (name: string) => {
        if (!images.has(name)) {
            images.set(name, api(`/api/upload/${name}`).then(r => (r.ok ? r.blob().then(dataUrl) : '')).catch(() => ''));
        }

        return images.get(name)!;
    };

    return { names, withoutLines, url };
}
