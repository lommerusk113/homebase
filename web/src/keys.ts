// Every injection key, typed. Provide at an island's root, inject with useInjected where used (web/README.md).
import { inject, type InjectionKey } from 'vue';
import type { useSessions } from '@/composables/useSessions';
import type { useProject } from '@/composables/useProject';

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
