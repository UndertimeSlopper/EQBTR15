// Builds dist/btr15-peq-writer.html: the whole app in one file, for opening
// straight from disk (Chrome blocks ES modules on file:// URLs).
// Usage: node scripts/build-single.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
let commit = 'dev';
try { commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }

const js = await build({
  entryPoints: [`${root}app/main.js`], bundle: true, format: 'iife', minify: false,
  write: false, target: 'chrome110', legalComments: 'none',
});
const css = readFileSync(`${root}app/style.css`, 'utf8');
let html = readFileSync(`${root}index.html`, 'utf8');
const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
html = html
  .replace('<link rel="stylesheet" href="app/style.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="app/main.js"></script>', () => `<script>\n${script}\n</script>`)
  .replace('href="docs/PROTOCOL.md"', 'href="https://github.com/UndertimeSlopper/EQBTR15/blob/main/docs/PROTOCOL.md"')
  .replace('<title>BTR15 PEQ Writer</title>', `<title>BTR15 PEQ Writer</title>\n<!-- single-file build of ${commit} -->`);
mkdirSync(`${root}dist`, { recursive: true });
writeFileSync(`${root}dist/btr15-peq-writer.html`, html);
console.log(`dist/btr15-peq-writer.html (${(html.length / 1024).toFixed(0)} kB, ${commit})`);
