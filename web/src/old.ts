// The bridge to the old page: its state as a ref that islands react to. Old actions are imported straight from
// 'old/<file>.js' (the same module instances the old page runs, see vite.config.ts).
import { shallowRef, triggerRef } from 'vue';
import { state, vue } from 'old/core.js';

// The old code mutates core.state in place and calls vue.bump() after (renderBoard does), which re-runs every
// render and computed that read oldState.value. Read it in each component that needs it, rather than passing old
// objects down as props: a child given the same object again doesn't re-render.
export const oldState = shallowRef(state);
vue.bump = () => triggerRef(oldState);
