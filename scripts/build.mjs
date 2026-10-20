// Bundles src/main.ts and inlines JS + CSS into one self-contained dist/index.html.
// One file means: double-click to open, or drop it on any free static host.
//
//   node scripts/build.mjs           build once
//   node scripts/build.mjs --serve   rebuild on change and serve http://localhost:5173
import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serve = process.argv.includes('--serve');

const options = {
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(root, 'dist/app.js'), // not written (write: false); names the output
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: !serve,
  sourcemap: serve ? 'inline' : false,
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
};

async function assemble(result) {
  const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text;
  const css = await readFile(join(root, 'src/styles.css'), 'utf8');
  const template = await readFile(join(root, 'index.html'), 'utf8');
  // A literal "</script" inside the bundle would end the inline tag early.
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const html = template
    .replace('<!--STYLES-->', () => `<style>\n${css}</style>`)
    .replace('<!--SCRIPT-->', () => `<script>\n${safeJs}</script>`);
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist/index.html'), html);
  return html.length;
}

if (!serve) {
  const result = await build(options);
  const size = await assemble(result);
  console.log(`dist/index.html  ${(size / 1024).toFixed(1)} KB`);
} else {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'assemble',
        setup(b) {
          b.onEnd(async (result) => {
            if (result.errors.length) return;
            await assemble(result);
            console.log(`rebuilt ${new Date().toLocaleTimeString()}`);
          });
        },
      },
    ],
  });
  await ctx.watch();
  createServer(async (_req, res) => {
    try {
      const html = await readFile(join(root, 'dist/index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(503).end('building…');
    }
  }).listen(5173, '127.0.0.1', () => console.log('http://localhost:5173'));
}
