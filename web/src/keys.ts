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

import type { useComposer } from '@/composables/useComposer';
import type { useAttachments } from '@/composables/useAttachments';
import type { useNotice } from '@/composables/useNotice';
import type { useStatus } from '@/composables/useStatus';
import type { useModel } from '@/composables/useModel';
import type { useChatActions } from '@/composables/useChatActions';
import type { usePush } from '@/composables/usePush';
import type { useAsk } from '@/composables/useAsk';
import type { useBoot } from '@/composables/useBoot';

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

// ---- the board (islands/Board.vue) ----
import type { Ref } from 'vue';
import type { useWorkItems } from '@/composables/useWorkItems';
import type { useSentMarks } from '@/composables/useSentMarks';
import type { useSelection } from '@/composables/useSelection';
import type { useComments } from '@/composables/useComments';
import type { useChatRows } from '@/composables/useChatRows';
import type { useReviews } from '@/composables/useReviews';
import type { useFolds } from '@/composables/useFolds';
import type { useForgeNotes } from '@/composables/useForgeNotes';
import type { useBoardGroups } from '@/composables/useBoardGroups';

export const WorkItemsKey: InjectionKey<ReturnType<typeof useWorkItems>> = Symbol('workItems');
export const SentMarksKey: InjectionKey<ReturnType<typeof useSentMarks>> = Symbol('sentMarks');
export const SelectionKey: InjectionKey<ReturnType<typeof useSelection>> = Symbol('selection');
export const CommentsKey: InjectionKey<ReturnType<typeof useComments>> = Symbol('comments');
export const ChatRowsKey: InjectionKey<ReturnType<typeof useChatRows>> = Symbol('chatRows');
export const ReviewsKey: InjectionKey<ReturnType<typeof useReviews>> = Symbol('reviews');
export const FoldsKey: InjectionKey<ReturnType<typeof useFolds>> = Symbol('folds');
export const ForgeNotesKey: InjectionKey<ReturnType<typeof useForgeNotes>> = Symbol('forgeNotes');
export const BoardGroupsKey: InjectionKey<ReturnType<typeof useBoardGroups>> = Symbol('boardGroups');
/** The work item a row shows: provided by Board/ItemRows.vue to the row's own parts. */
export const ItemKey: InjectionKey<Readonly<Ref<WorkItem>>> = Symbol('item');

// The composer and the question cards (islands/Composer.vue, islands/Ask.vue)
export const ComposerKey: InjectionKey<ReturnType<typeof useComposer>> = Symbol('composer');
export const AttachmentsKey: InjectionKey<ReturnType<typeof useAttachments>> = Symbol('attachments');
export const NoticeKey: InjectionKey<ReturnType<typeof useNotice>> = Symbol('notice');
export const StatusKey: InjectionKey<ReturnType<typeof useStatus>> = Symbol('status');
export const ModelKey: InjectionKey<ReturnType<typeof useModel>> = Symbol('model');
export const ChatActionsKey: InjectionKey<ReturnType<typeof useChatActions>> = Symbol('chatActions');
export const PushKey: InjectionKey<ReturnType<typeof usePush>> = Symbol('push');
export const AskKey: InjectionKey<ReturnType<typeof useAsk>> = Symbol('ask');
export const BootKey: InjectionKey<ReturnType<typeof useBoot>> = Symbol('boot');
