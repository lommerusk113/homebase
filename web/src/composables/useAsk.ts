import { nextTick, ref, shallowRef } from 'vue';
import { api, composer, seenHash, setFormatWarn } from 'old/core.js';
import { answered } from 'old/chat.js';
import { useChat } from './useChat';
import { useComposerFocus } from './useComposerFocus';
import { useModel } from './useModel';
import { useNotice } from './useNotice';
import { useSend } from './useSend';

export interface CardOption { label: string; desc?: string; quiet?: boolean }
/** A question card: its options, and `answer` to pick one (null: read-only rows, answered in the terminal). */
export interface Card {
    tmux: string;
    question: string;
    options: CardOption[];
    answer: ((n: number) => Promise<void>) | null;
    /** a permission prompt's command or diff, in red when the server flags it risky */
    detail?: string;
    risky?: boolean;
}
interface PaneQuestion { question: string; options: string[]; descriptions: string[]; selected: number; detail?: string; risky?: boolean }

/** POSTs an answer; a refusal's text is the error. */
export async function postAnswer(url: string) {
    const r = await api(url, { method: 'POST' });
    if (!r.ok) {
        throw new Error(await r.text());
    }
}

const TEXT_BOX = /^type something\.?$/i; // Claude's own text-box entry under a question: the chat input below covers it
const CHAT = /^chat about this$/i; // declines the question as "the user wants to clarify"; Claude then asks what about
const GRANT = /^yes, .*(?:don't ask again|auto mode|accept edits)/i; // a permission option that also approves what comes later
const flat = (t: string) => t.replace(/\s+/g, ' ').trim();

const { dialogOn, refresh } = useChat();
const { picked } = useModel();
const { showError } = useNotice();
const { send } = useSend();
const { focus } = useComposerFocus();

const card = shallowRef<Card | null>(null);
const shown = ref(false); // shown once filled, never empty
let drawn: string | null = null; // what the card shows, so an unchanged question isn't redrawn under a click
let answeredAsk: string | null = null; // data.asking of the question last answered on the pane, until the transcript stops asking it
let paneUrl = '';

async function readPane(url: string): Promise<PaneQuestion | null> {
    try {
        const r = await api(url);

        return r.ok ? (await r.json()).question : null;
    } catch {
        return null;
    }
}

function hide() {
    shown.value = false;
    drawn = null;
}

// The question on the tmux pane gets buttons (the server moves the ❯ there and confirms, one question at a time);
// descriptions come from the transcript, else the pane. No question readable there: the transcript's, see below.
async function check(s: Session, data: Transcript) {

    if (!data.asking) {
        setFormatWarn('pane', false);
        answeredAsk = null;
        if (dialogOn.value !== s.id) {
            return hide();
        }
    }

    const tmux = s.tmux ?? `cc-${s.id.slice(0, 8)}`, url = `/api/question?tmux=${encodeURIComponent(tmux)}`;
    const pane = await readPane(url);
    if (!data.asking && !pane) {
        dialogOn.value = picked.value?.sid === s.id ? dialogOn.value : null; // a pending pick: its dialog may still be drawing
        return hide();
    }
    setFormatWarn('pane', !pane && data.asking !== answeredAsk); // the transcript asks but the screen shows no question we can parse
    const key = JSON.stringify([tmux, data.questions, data.asking, pane && [pane.question, pane.detail, pane.options, pane.descriptions]]); // not the moving ❯
    if (key === drawn) {
        return;
    }
    drawn = key;
    paneUrl = url;
    shown.value = !(!pane && data.asking === answeredAsk); // answered, the transcript just hasn't caught up: never re-show its options
    if (!shown.value) {
        return;
    }

    const questions: NonNullable<Transcript['questions']> = data.questions?.length ? data.questions : data.asking ? [{ question: data.asking, options: [] }] : [];
    const again = () => {
        drawn = null;
        refresh(); // fresh transcript: the pane shows the next question or none, and `data` still has the answered one
    };
    if (!pane) {
        // no question readable on the pane (not in tmux, or a screen this can't parse): one question's options still answer by
        // click, typed as a message naming the question (the server declines the dialog first); several stay read-only
        const one = questions.length === 1 && questions[0].options.length ? questions[0] : null;
        card.value = {
            tmux,
            question: questions.map(q => q.question).join(' · '),
            options: questions.flatMap(q => q.options.map((label, i) => ({ label, desc: q.descriptions?.[i] }))),
            answer: one && (async n => {
                if (await send(s.id, one.options[n], undefined, `(Answering your question: "${one.question}")`)) {
                    answeredAsk = data.asking;
                }
                again();
            })
        };
        return;
    }

    const known = questions.find(q => flat(q.question).endsWith(pane.question)); // a question taller than the pane shows only its end
    const options = pane.options.map((label, i) => ({ i, label, desc: known?.descriptions?.[known.options.indexOf(label)] || pane.descriptions[i], quiet: CHAT.test(label) || GRANT.test(label) }))
        .filter(o => !TEXT_BOX.test(o.label))
        .sort((a, b) => Number(a.quiet) - Number(b.quiet)); // quiet ones last: Yes and No stay the big pair
    // not on a dialog that isn't the transcript's question ("Switch model?"): Esc there declines nothing
    if (data.questions?.length && (known || /^Review your answers/.test(pane.question)) && !options.some(o => CHAT.test(o.label))) {
        options.push({ i: -1, label: 'Chat about this', desc: '', quiet: true }); // no such entry on the pane: Esc declines instead
    }
    card.value = {
        tmux, options, question: known?.question ?? pane.question, detail: pane.detail, risky: pane.risky,
        async answer(n) {
            const o = options[n];
            try {
                await postAnswer(`${url}&${o.i < 0 ? 'dismiss=1' : `option=${o.i}&label=${encodeURIComponent(o.label)}&seen=${seenHash(pane)}`}`);
                answeredAsk = data.asking;
                answered(s.id);
                if (CHAT.test(o.label)) {
                    focus(); // the user's turn to say what they want instead
                }
            } finally {
                again();
            }
        }
    };
}

// the old refresh goes on (to the feed, and to focus the question) once the card is drawn
composer.ask = async (s, data) => {
    await check(s, data);
    await nextTick();
};

/** The "Claude is asking" card: the question open on the chat's tmux pane, answered from here. */
export function useAsk() {
    return {
        card, shown,
        /** Esc in the chat: the transcript then shows the question declined. */
        async dismiss() {
            shown.value = false;
            try {
                await postAnswer(`${paneUrl}&dismiss=1`);
            } catch (e) {
                shown.value = true;
                showError((e as Error).message);
            } finally {
                drawn = null;
            }
        }
    };
}
