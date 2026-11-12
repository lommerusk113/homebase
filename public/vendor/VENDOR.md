# Vendored third-party code

Served by `server.mjs` under `/vendor/` so the page loads nothing from a CDN.
Each tarball was downloaded from the npm registry and its sha512 checked against the registry's `dist.integrity` before extraction.
Files are copied unmodified.

| Package | Version | Tarball | Integrity |
|---|---|---|---|
| `@awesome.me/webawesome` | 3.14.0 | https://registry.npmjs.org/@awesome.me/webawesome/-/webawesome-3.14.0.tgz | `sha512-m5rTGLK/iOvaVFOkYxRjiBOp8lwrBap5tv+zz1gsqLgAxlfwdvElB7BVGjs+Lf9gDps7bWRPTkG0FwZk40mk2A==` |
| `marked` | 15.0.7 | https://registry.npmjs.org/marked/-/marked-15.0.7.tgz | `sha512-dgLIeKGLx5FwziAnsk4ONoGwHwGPJzselimvlVskE9XLN4Orv9u2VA3GWw/lYUqjfA0rUT/6fqKwfZJapP9BEg==` |
| `dompurify` | 3.2.4 | https://registry.npmjs.org/dompurify/-/dompurify-3.2.4.tgz | `sha512-ysFSFEDVduQpyhzAob/kkuJjf5zWkZD8/A9ywSp1byueyuCfHamrCBa14/Oc2iiB0e51B+NpxSl5gmzn+Ms/mg==` |
| `@fontsource/inter` | 5.3.0 | https://registry.npmjs.org/@fontsource/inter/-/inter-5.3.0.tgz | `sha512-RofMylZmjlJEfELXeNHFWBRcSs75rGU/6bV2S2jfnvv/3rPXPGe0LgUJTklcHZ9lM4OZmAVFhcJPnACfb91A3g==` |
| `@fontsource/jetbrains-mono` | 5.3.0 | https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz | `sha512-fqDfB5I9f1p1TV486aUgB9t8zP84P0O1FtQR5Ol9vjwPy+S+EIGlVYm1cvj2W5shcZMTg2nZFdVMoH5wFu8a1A==` |

## What was copied

* `webawesome/` from `package/dist-cdn/`: `webawesome.loader.js`, the components the page uses (button, dialog, dropdown, dropdown-item, select, option, textarea, tooltip, badge, details, input, icon) plus those they render (spinner, popup, tag), every chunk those files import, and `styles/themes/default.css` with its `@import`s.
  Built-in icons are the `system` library, which is inline `data:` SVG, so no icon files are needed.
  The page sets the loader's base path with `data-webawesome="/vendor/webawesome"`.
* `marked/marked.min.js` from `package/marked.min.js`.
* `dompurify/purify.min.js` from `package/dist/purify.min.js`.
* `fonts/`: the latin `woff2` files for Inter 400/500/600/700 and JetBrains Mono 400/500 from `package/files/`, with `@font-face` rules in `fonts/fonts.css`.

## Updating

Bump the version, download and verify the new tarball the same way, and replace the files above.
If the page starts using a new `wa-*` component, copy that component, the chunks it imports and any `wa-*` it renders; a missing one shows as "Unable to autoload" in the console.
