// The islands' entry: the old page calls mount(name, el, props) through vue.load() in public/core.js.
import { createApp, type Component } from 'vue';
import './old';
import './style.css';

// Every src/islands/<Name>.vue, so adding an island edits no shared file.
const islands = import.meta.glob<{ default: Component }>('./islands/*.vue', { eager: true });

/** Mounts island <name> into el (marked .hb-island for its styles); returns the unmount, for when old code redraws el. */
export function mount(name: string, el: Element, props?: Record<string, unknown>): () => void {

    const island = islands[`./islands/${name}.vue`];
    if (!island) {
        throw new Error(`no island ${name} in web/src/islands`);
    }

    el.classList.add('hb-island');
    const app = createApp(island.default, props);
    app.mount(el);

    return () => app.unmount();
}
