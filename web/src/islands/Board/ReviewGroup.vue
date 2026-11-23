<script setup lang="ts">
import { ReviewsKey, useInjected } from '@/keys';
import GroupDot from './GroupDot.vue';
import ReviewRow from './ReviewRow.vue';

const { reviews } = useInjected(ReviewsKey);
</script>

<template>
    <section class="group g-reviews">
        <h2 class="g-head"><GroupDot column="review" />Review requested · {{ reviews.length }}</h2>
        <table class="rows" aria-label="Review requested">
            <ReviewRow v-for="r in reviews" :key="r.url" :url="r.url" />
        </table>
    </section>
</template>
