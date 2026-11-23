import { ref, shallowRef } from 'vue';
import { api } from 'old/core.js';
import { useNotice } from './useNotice';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const attached = shallowRef<File[]>([]);
const dropping = ref(false); // files are being dragged over the composer

/** Images attached to the next message. Sent as "[Image: <path>]" lines after uploading; Claude reads them by path. */
export function useAttachments() {

    const { error } = useNotice();

    function attach(files: Iterable<File>) {

        const list = [...files];
        const ok = list.filter(f => IMAGE_TYPES.includes(f.type));
        if (ok.length < list.length) {
            error.value = 'Only PNG, JPEG, GIF or WebP images can be attached';
        }

        attached.value = [...attached.value, ...ok];
    }

    const remove = (files: File[]) => { attached.value = attached.value.filter(f => !files.includes(f)); };

    /** Uploads files; their "[Image: <path>]" lines, one per image. */
    const upload = (files: File[]): Promise<string[]> => Promise.all(files.map(async f => {
        const r = await api('/api/upload', { method: 'POST', headers: { 'content-type': f.type }, body: f });
        if (!r.ok) {
            throw new Error(`${f.name}: ${await r.text()}`);
        }

        return `[Image: ${(await r.json()).path}]`;
    }));

    return { attached, dropping, attach, remove, upload };
}
