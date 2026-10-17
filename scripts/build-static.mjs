// Builds dist/: a server-less version of the site for static hosting (e.g. a claude.ai Artifact).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
fs.mkdirSync(path.join(DIST, 'js/sim'), { recursive: true });
for (const f of ['engine.js', 'rng.js', 'data.js']) fs.copyFileSync(path.join(ROOT, 'server', f), path.join(DIST, 'js/sim', f));
for (const f of fs.readdirSync(path.join(ROOT, 'static'))) fs.copyFileSync(path.join(ROOT, 'static', f), path.join(DIST, 'js', f));

const cssPath = path.join(DIST, 'css/styles.css');
fs.writeFileSync(cssPath, `@charset "UTF-8";\n${fs.readFileSync(cssPath, 'utf8')}`);

// Artifact hosts wrap the page in their own document skeleton and serve it under a sub-path.
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const head = html.split('<head>')[1].split('</head>')[0]
  .split('\n').filter((l) => !/charset|name="viewport"|theme-color/.test(l)).join('\n')
  .replace('href="/css/styles.css"', 'href="css/styles.css"');
const body = html.split('<body>')[1].split('</body>')[0].replace('src="/js/app.js"', 'src="js/boot.js"');
fs.writeFileSync(path.join(DIST, 'index.html'), `<meta charset="utf-8" />\n<style>:root{color-scheme:dark}</style>\n${head.trim()}\n${body}`);
console.log(`built ${path.relative(ROOT, DIST)}/`);
