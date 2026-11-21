import assert from 'node:assert/strict';

// Reply text is untrusted: rich() keeps only what the markdown renderer itself emits. [markdown, expected innerHTML of the .body]
const HOSTILE = [
    ['<style>body{display:none}</style>hi', 'hi'],
    ['<div style="position:fixed;inset:0" id="chat" class="composer" name="x">cover</div>', 'cover'],
    ['<p style="color:red" id="feed" class="bubble" data-x="1" aria-hidden="true">x</p>', '<p>x</p>'],
    ['<form action="/api/send"><input name="q"><textarea>t</textarea><select><option>o</option></select><button>Approve</button></form>', 'toApprove'],
    ['<link rel="stylesheet" href="/x.css"><base href="https://evil.example/"><meta http-equiv="refresh" content="0">ok', 'ok'],
    ['<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x"><svg><circle r="9"/></svg>ok', 'ok'],
    ['<img src=x onerror=alert(1)><script>alert(1)</script>ok', '<p><img>ok</p>'],
    ['<img src="https://evil.example/pixel.png" alt="a">', '<img alt="a">'],
    ['<img src="/api/sessions" alt="a">', '<img alt="a">'],
    ['[x](javascript:alert(1))', '<p><a>x</a></p>'],
    ['<a href="data:text/html,hi">x</a>', '<p><a>x</a></p>'],
    ['<a href="/api/server/reload" target="_self" rel="opener">x</a>', '<p><a>x</a></p>'],
    ['<code class="composer language-js">x</code>', '<p><code>x</code></p>'],
    ['<details open><summary>s</summary>d</details>', 'sd']
];
const KEPT = [
    ['# T\n\nsome **bold** *em* ~~gone~~ `code`', '<h1>T</h1>\n<p>some <strong>bold</strong> <em>em</em> <del>gone</del> <code>code</code></p>\n'],
    ['```js\nconst a = 1 < 2;\n```', '<pre><code>const a = 1 &lt; 2;\n</code></pre>\n'],
    ['| a | b |\n|:--|--:|\n| 1 | 2 |', '<table>\n<thead>\n<tr>\n<th align="left">a</th>\n<th align="right">b</th>\n</tr>\n</thead>\n<tbody><tr>\n<td align="left">1</td>\n<td align="right">2</td>\n</tr>\n</tbody></table>\n'],
    ['[site](https://example.com "tip") <mailto:a@example.com>', '<p><a title="tip" href="https://example.com" rel="noopener noreferrer" target="_blank">site</a> <a href="mailto:a@example.com" rel="noopener noreferrer" target="_blank">mailto:a@example.com</a></p>\n'],
    ['![dot](data:image/png;base64,iVBORw0KGgo=)', '<p><img alt="dot" src="data:image/png;base64,iVBORw0KGgo="></p>\n'],
    ['3. a\n4. b\n\n> q\n\n---', '<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>\n<blockquote>\n<p>q</p>\n</blockquote>\n<hr>\n'],
    ['- [x] done\n- [ ] open', '<ul>\n<li>☑ done</li>\n<li>☐ open</li>\n</ul>\n']
];

export default {
    'rendered reply text keeps only what markdown emits': async ({ page, open }) => {
        await open();
        const cases = [...HOSTILE, ...KEPT];
        const got = await page.ev(`import('/core.js').then(m => ${JSON.stringify(cases.map(c => c[0]))}.map(t => m.rich(t).innerHTML))`);
        const off = cases.flatMap(([input, want], i) => (got[i].trim() === want.trim() ? [] : [{ input, got: got[i], want }]));
        assert.ok(!off.length, JSON.stringify(off, null, 1));
        assert.equal(await page.ev(`import('/core.js').then(m => m.rich('<b style="x" id="i">a</b> **b**', true).innerHTML)`), 'a <strong>b</strong>', 'inline too');
    }
};
