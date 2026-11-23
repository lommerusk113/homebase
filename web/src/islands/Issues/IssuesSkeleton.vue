<template>
    <!-- grey placeholder lanes while the issues load: three lanes of a few cards -->
    <section v-for="n in 3" :key="n" class="lane skel">
        <div class="who"><i class="bone" /><i class="bone short" /></div>
        <div class="strip"><i v-for="c in 4 - n" :key="c" class="bone card" /></div>
    </section>
</template>
