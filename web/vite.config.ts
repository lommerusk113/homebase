import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// Library build: one ES module (web/dist/main.js) plus its CSS (main.css), loaded by the old page (public/index.html).
export default defineConfig({
    plugins: [
        // <wa-button>, <wa-details> and friends are the old page's Web Awesome elements, not Vue components
        vue({ template: { compilerOptions: { isCustomElement: tag => tag.startsWith('wa-') } } }),
        tailwindcss(),
        // 'old/core.js' -> an external '/core.js': islands import the very module instances the old page runs, never
        // copies. tsconfig.json maps the same name to ../public for the types.
        { name: 'old-page', enforce: 'pre', resolveId: id => (id.startsWith('old/') ? { id: id.slice(3), external: true } : null) }
    ],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    // library mode leaves process.env.NODE_ENV in Vue's code; the browser has no process
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
        target: 'es2022',
        lib: { entry: 'src/main.ts', formats: ['es'], fileName: 'main', cssFileName: 'main' }
    }
});
