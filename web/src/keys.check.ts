// Never bundled, only type-checked (vue-tsc, part of npm run build): each line must fail to compile, so an inject
// that lost its type, or a string key, breaks the build instead of reaching the page.
import { useInjected, SessionsKey } from '@/keys';

export function mistypedInjects() {

    // @ts-expect-error visible is Session[], not a number
    useInjected(SessionsKey).visible.value.toFixed();
    // @ts-expect-error string keys are not InjectionKeys
    useInjected('sessions');
}
