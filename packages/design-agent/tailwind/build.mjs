// Builds dist/tailwind.css from src/tailwind.css with PostCSS
// (Tailwind, then the v3 output fixes). Replaces the Tailwind CLI, whose
// file watcher pulls in dependencies this build never needs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import v3Output from './postcss-v3-output.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src/tailwind.css');
const to = path.join(root, 'dist/tailwind.css');

const result = await postcss([tailwindcss({ base: root, optimize: { minify: true } }), v3Output()])
  .process(fs.readFileSync(from, 'utf8'), { from, to });

fs.mkdirSync(path.dirname(to), { recursive: true });
fs.writeFileSync(to, result.css);
console.log(`Wrote ${path.relative(root, to)} (${result.css.length} bytes)`);
