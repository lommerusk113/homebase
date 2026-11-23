// The bridge to the old page: its state as a ref that islands react to. Old actions are imported straight from
// 'old/<file>.js' (the same module instances the old page runs, see vite.config.ts).
import { shallowRef, triggerRef } from 'vue';
import { lib, state, vue } from 'old/core.js';
import * as board from '@/lib/board';
import * as chat from '@/lib/chat';
import * as comments from '@/lib/comments';
import * as forge from '@/lib/forge';
import * as limits from '@/lib/limits';
import * as text from '@/lib/text';
import * as time from '@/lib/time';
import * as waiting from '@/lib/waiting';

// The old code mutates core.state in place and calls vue.bump() after (renderBoard does), which re-runs every
// render and computed that read oldState.value. Read it in each component that needs it, rather than passing old
// objects down as props: a child given the same object again doesn't re-render.
export const oldState = shallowRef(state);
vue.bump = () => triggerRef(oldState);

// The old page's pure helpers are web/src/lib/*.ts: hand it these very modules (its `lib` in core.js), so the clock skew
// and the rest are the instances the islands use.
Object.assign(lib, time, limits, forge, text, chat, comments, waiting, board);
