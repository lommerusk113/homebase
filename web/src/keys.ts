// Every injection key, typed. Provide at an island's root, inject with useInjected where used (web/README.md).
import { inject, type InjectionKey } from 'vue';
import type { useSessions } from '@/composables/useSessions';
import type { useProject } from '@/composables/useProject';
import type { useFeed } from '@/composables/useFeed';
import type { useImages } from '@/composables/useImages';
import type { useNewMarker } from '@/composables/useNewMarker';
import type { useOutbox } from '@/composables/useOutbox';
import type { useSend } from '@/composables/useSend';
import type { useUnfold } from '@/composables/useUnfold';
import type { useUnread } from '@/composables/useUnread';

export const SessionsKey: InjectionKey<ReturnType<typeof useSessions>> = Symbol('sessions');
export const ProjectKey: InjectionKey<ReturnType<typeof useProject>> = Symbol('project');

/** inject() that returns T: throws, naming the key, when no ancestor provides it. */
export function useInjected<T>(key: InjectionKey<T>): T {

    const value = inject(key);
    if (value === undefined) {
        throw new Error(`nothing provides ${key.description ?? 'this key'}: provide it at the island's root`);
    }

    return value;
}

// The Changes view (islands/Diff.vue)
export const DiffKey: InjectionKey<ReturnType<typeof import('@/composables/useDiff').useDiff>> = Symbol('diff');

// the chat feed (islands/Feed.vue)
export const FeedKey: InjectionKey<ReturnType<typeof useFeed>> = Symbol('feed');
export const ImagesKey: InjectionKey<ReturnType<typeof useImages>> = Symbol('images');
export const NewMarkerKey: InjectionKey<ReturnType<typeof useNewMarker>> = Symbol('new-marker');
export const OutboxKey: InjectionKey<ReturnType<typeof useOutbox>> = Symbol('outbox');
/** sending to a chat, and the composer's error line and focus: shared with the composer */
export const SendKey: InjectionKey<ReturnType<typeof useSend>> = Symbol('send');
/** which folds (Show more) are open */
export const UnfoldKey: InjectionKey<ReturnType<typeof useUnfold>> = Symbol('unfold');
export const UnreadKey: InjectionKey<ReturnType<typeof useUnread>> = Symbol('unread');
