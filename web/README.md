# web/: the Vue islands

The page is moving from plain JS (`public/`) to Vue, one section at a time.
Each ported section is an *island*: a Vue app mounted into the old page in place of the DOM the old code built, live on the real page as soon as it lands.

Stack: Vue 3, TypeScript, Vite (library build), Tailwind CSS v4 (Vite plugin, no preflight), shadcn-vue on Reka UI (`components.json`, `src/components/ui/`).
Versions are pinned exactly in `package.json`.

## Commands

```sh
cd web
npm ci            # once
npm run build     # vue-tsc type check, then web/dist/main.js and main.css
npm run dev       # rebuilds on every save; reload the page (no HMR)
npm run check     # the type check alone
npx shadcn-vue@2.9.0 add <component>   # then fix its `cn` import to "@/lib/utils" if the CLI wrote `from "cn"`
```

`web/dist` is gitignored.
The server serves `/web/main.js` and `/web/main.css` from it (`server/static.mjs`) and puts their tags into `index.html` only when `web/dist/main.js` exists, so without a build the page runs exactly as before.
Develop against the real server: `npm run dev` here, the page at `http://localhost:4321/`; a rebuild shows the page's "reload" notice.

## How it fits together

* `src/main.ts` exports `mount(name, el, props)`; it finds `src/islands/<Name>.vue` by `import.meta.glob`, so adding an island edits no shared registry. It adds `.hb-island` to `el` and returns the unmount.
* The old code reaches it through `vue` in `public/core.js`: `vue.load()` resolves to that module, or `null` when `web/` isn't built.
* `import ... from 'old/<file>.js'` imports the old page's own modules (`/core.js`, `/list.js`, …): external in the build, so the very instances the page runs; typed from their JSDoc through `tsconfig.json`'s paths.
* API response types are global, from `public/api.d.ts`, which the old page's check (`../check-types.sh`) uses too.
* Styles: Tailwind's utilities in a cascade layer, so the old page's unlayered rules win wherever both apply; no preflight, only a small reset inside `.hb-island`. shadcn's tokens are set on `.hb-island` as `--ui-muted`, `--ui-accent`, … (Tailwind's `bg-muted` etc. map to them), because the old page uses the plain names and its classes keep working inside an island. Never remove `.hb-island` from a host.
  A Reka portal (dialog, popover) renders outside the island: give it a `to` inside the island when the first one is ported.

## State bridge

The old code changes `core.state` in place and then redraws. `src/old.ts` wraps it in one `shallowRef`, `oldState`, and sets `vue.bump()` to `triggerRef` it; `renderBoard()` calls `vue.bump()` after every redraw.
So anything that reads `oldState.value` re-runs after the old code changes state and redraws the board.
A section whose state changes without a board redraw (the chat, the diff viewer) calls `vue.bump()` where it changes it, when that section is ported.

A section with its own data flow, where a board bump must not redraw it, uses a **port** instead, like the chat feed's `feedPort = { merge, show }` in `public/chat.js`. The old module exports an empty object, the section's composable (`useFeed.ts`) fills in its functions when `web/dist` loads, and the old code calls them where it used to draw. The composable keeps its own `shallowRef`, so only that section redraws.

Each island is its own Vue app, so give `useId()` ids a section prefix (`feed-`, …): bare ids collide across islands.

Composables are the only readers of `oldState`.
They return getter refs, `toRef(() => oldState.value.x)`, not `computed`: a computed that returns the same (mutated) object again doesn't notify what depends on it, while a getter ref reads `oldState` on every access.
Use `computed` only for a derived value whose getter itself reads `oldState.value`.
Old actions are plain functions the composable wraps: `hooks.setProject`, `select` from `old/list.js`, `refreshChat` from `old/chat.js`, `openDiff` from `old/diff.js`.

The other way round, old code that needs a ported section goes through an object in `public/core.js` that the section's composables fill in when `main.js` loads.
`feedPort` in `old/chat.js` is one, `composer` another: `refreshChat` hands the composer and the question cards what it found (`composer.turn`, `ask`, `boot`), and the old page's buttons send through `composer.send` (`sendText` in `old/chat.js` is only that call).
State owned by a ported section lives at module level in its composable, so the chat's islands (`Feed`, `Composer`, `Ask`) and those calls share it.
Pure helpers with a unit test sit in `src/lib/` without Vue or `old/` imports, so `tests/unit` imports the `.ts` file directly (Node 22.18 or newer).

## Rules for Vue code

1. **Provide/inject, not props down.** Shared data and actions are provided once at the island's root and injected where used. Props only for a component's own direct input, like the row it shows.
2. **Typed keys.** Every key is an `InjectionKey<T>` symbol in `src/keys.ts`; inject with `useInjected(key)`, which returns `T` and throws, naming the key, when nothing provides it. Never string keys. `src/keys.check.ts` holds lines that must not compile (vue-tsc fails the build if they ever do):

   ```
   error TS2339: Property 'toFixed' does not exist on type 'Session[]'.
   error TS2345: Argument of type 'string' is not assignable to parameter of type 'InjectionKey<unknown>'.
   ```
3. **One composable per concern** in `src/composables/` (`useSessions`, `useProject`; next `useWorkItems`, `useSelection`, `useOutbox`, `useMilestoneFilter`, `useDiff`). Each owns its state and logic, is typed and works on its own. Components only present, and call composables or injected values.
4. **Many small components**, about 100 lines per `.vue` at most, template included. Split as soon as a part has its own job (a row: title, next-step line, progress bar, MR chip, CI pill, action button). Shared bits (chips, pills, badges) go in `src/components/`, a section's own in `src/islands/<Section>/`.

`src/islands/Demo.vue` follows all four: it provides `useSessions()` and `useProject()` under their keys, and `Demo/ChatCount.vue` and `Demo/AllProjects.vue` inject them. It shows in the header with `?vue=1`.

## How to port a section

1. Add `src/islands/<Section>.vue` (its root: provides the composables it needs) and its parts in `src/islands/<Section>/`.
2. In the old code, replace the DOM-building function's body with a mount, and keep the unmount for when the old code redraws or removes that spot:

   ```js
   let unmount = null;
   export function renderThing(el) {
       vue.load().then(m => { unmount?.(); unmount = m?.mount('Thing', el) ?? null; });
   }
   ```
   Mount once and let the bump redraw it, rather than mounting again on every render.
3. Read state through composables (new ones in `src/composables/`, keys in `src/keys.ts`), and call old actions through them.
4. Keep the classes, ids and `data-` attributes the browser tests (`tests/browser/`) look for, or update those tests in the same commit.
5. Once a section is ported its old builder is gone, so the page needs `web/dist` from then on.
6. Checks: `npm run build` here, then from the repo root `node test.mjs`, `./check-types.sh` and `node tests/browser/run.mjs` (with `web/dist` built; `islands.test.mjs` skips without it).

## Porting order

Ported: the board (`Board`), the chat feed (`Feed`), the composer and question cards (`Composer`, `Ask`), the Changes viewer (`Diff`, `DiffButton`), the header and Issues tab (`Header`, `Issues`), and the footer's Token saver switch (`TokenSaver`, with `useTokenSaver`; the setting lives on the server, `server/saver.mjs`).

Left in old code: the waiting strip and rules strip (`public/chat.js`), the limits strip, bell and projects dialog (`public/app.js`), keyboard handling (`public/keys.js`), and the shell (bootstrapping, polling, the phone tabs).
Next: the phone layout, then the shell itself, after which `public/` is deleted. Pure logic the node unit tests import from `public/*.js` moves to `web/src/lib/` along the way.
