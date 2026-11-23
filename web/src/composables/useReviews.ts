import { computed } from 'vue';
import { oldState } from '@/old';

/** "Review requested": open MRs by someone else that ask the user for a review, in the picked project. */
export function useReviews() {

    const reviews = computed(() => {
        const { project, reviews = [] } = oldState.value;

        return reviews.filter(r => project === 'all' || r.project.split('/').pop() === project);
    });
    const byUrl = computed(() => new Map(reviews.value.map(r => [r.url, r])));

    return { reviews, byUrl, open: (r: ReviewRequest) => window.open(r.url, '_blank', 'noopener') };
}
