// Puts two parts of Tailwind 4's output back into the form Tailwind 3
// emitted, where CSS alone can't (v3-compat.css beside this file covers the
// rest). Runs after @tailwindcss/postcss in build.mjs.
//
// 1. Opacity modifiers (bg-white/5, text-primary/40). v4 writes them as
//    color-mix(in oklab, <color> N%, transparent), and its minifier folds the
//    ones with literal colors into oklab(). Chromium rasterizes those oklab
//    colors slightly differently from rgb() alpha, most visibly on
//    translucent text. They become rgb(r g b / a) again. Palette colors
//    arrive as var(--color-*) and are resolved from the theme variables in
//    the same stylesheet; design tokens arrive as rgb(var(--token)) and keep
//    the variable.
//
// 2. space-* and divide-*. v4 targets :where(.space-y-4 > :not(:last-child))
//    and spaces with the trailing margin; v3 targeted
//    .space-y-4 > :not([hidden]) ~ :not([hidden]) with the leading margin.
//    They differ when a child is display:none or has its own margins, and
//    double up where a host page also loads a Tailwind 3 stylesheet. The
//    rules get v3's selector and sides back.

const SPACING_SIDES = {
  'margin-block-start': 'margin-bottom',
  'margin-block-end': 'margin-top',
  'margin-inline-start': 'margin-right',
  'margin-inline-end': 'margin-left',
  'border-top-width': 'border-bottom-width',
  'border-bottom-width': 'border-top-width',
  'border-inline-start-width': 'border-right-width',
  'border-inline-end-width': 'border-left-width',
  'border-inline-start-style': 'border-right-style',
  'border-inline-end-style': 'border-left-style',
};
const BETWEEN_CHILDREN = /:where\(((?:\\.|[^()\s>])+)\s*>\s*:not\(:last-child\)\)/g;

function restoreBetweenChildren(rule) {
  if (!rule.selector.includes(':not(:last-child))')) return;
  const selector = rule.selector.replace(BETWEEN_CHILDREN, '$1 > :not([hidden]) ~ :not([hidden])');
  if (selector === rule.selector) return;
  rule.selector = selector;
  rule.walkDecls((d) => {
    if (SPACING_SIDES[d.prop]) d.prop = SPACING_SIDES[d.prop];
  });
}

const MIX = /color-mix\(in oklab,\s*/g;

const round = (x) => Number(x.toFixed(4)).toString();

function hexToColor(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { channels: `${n(0)} ${n(2)} ${n(4)}`, a: h.length === 8 ? n(6) / 255 : 1 };
}

// oklab -> sRGB (https://bottosson.github.io/posts/oklab/), 8-bit channels.
function oklabToColor(body) {
  const m = /^\s*(\S+)\s+(\S+)\s+(\S+)\s*(?:\/\s*(\S+))?\s*$/.exec(body.replace('/', ' / '));
  if (!m) return null;
  const num = (s, pct) => (s === 'none' ? 0 : s.endsWith('%') ? parseFloat(s) / 100 * pct : parseFloat(s));
  const L = num(m[1], 1), A = num(m[2], 0.4), B = num(m[3], 0.4);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const ch = lin.map((x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(v * 255)));
  });
  return { channels: ch.join(' '), a: m[4] === undefined ? 1 : num(m[4], 1) };
}

// Parses the colors Tailwind feeds into a mix; null for anything else.
function parseColor(color, palette) {
  const v = /^var\((--color-[\w-]+)\)$/.exec(color);
  if (v) color = palette.get(v[1]) || color;
  let m;
  if ((m = /^rgb\((var\(--[\w-]+\))(?:\s*\/\s*([\d.]+))?\)$/.exec(color))) {
    return { channels: m[1], a: m[2] === undefined ? 1 : parseFloat(m[2]) };
  }
  if (/^#[0-9a-f]+$/i.test(color)) return hexToColor(color);
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(color))) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { channels: `${m[1]} ${m[2]} ${m[3]}`, a };
  }
  if ((m = /^oklab\((.*)\)$/.exec(color))) return oklabToColor(m[1]);
  return null;
}

// amount is "N%" or a variable such as var(--tw-shadow-alpha).
function toLegacy(color, amount, palette) {
  const c = parseColor(color, palette);
  if (!c) return null;
  let alpha;
  if (/^[\d.]+%$/.test(amount)) alpha = round(c.a * parseFloat(amount) / 100);
  else if (/^var\(--[\w-]+\)$/.test(amount)) alpha = c.a === 1 ? amount : `calc(${round(c.a)} * ${amount})`;
  else return null;
  return `rgb(${c.channels} / ${alpha})`;
}

// Index of the paren closing the one opened just before `from`.
function closeParen(value, from) {
  for (let depth = 1, i = from; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function rewrite(value, palette) {
  let out = '';
  let i = 0;
  MIX.lastIndex = 0;
  for (let m; (m = MIX.exec(value)); ) {
    const end = closeParen(value, MIX.lastIndex);
    if (end < 0) break;
    const inner = rewrite(value.slice(MIX.lastIndex, end), palette);
    const parts = /^(.*?)\s+([\d.]+%|var\(--[\w-]+\))\s*,\s*transparent\s*$/s.exec(inner);
    const legacy = parts && toLegacy(parts[1].trim(), parts[2], palette);
    out += value.slice(i, m.index) + (legacy || `color-mix(in oklab, ${inner})`);
    i = MIX.lastIndex = end + 1;
  }
  out += value.slice(i);
  // Literal colors the minifier already folded to oklab().
  return out.replace(/oklab\(([^()]*)\)/g, (whole, body) => {
    const c = oklabToColor(body);
    return c ? `rgb(${c.channels} / ${round(c.a)})` : whole;
  });
}

module.exports = () => ({
  postcssPlugin: 'tailwind-v3-output',
  Once(root) {
    root.walkRules(restoreBetweenChildren);
    const palette = new Map();
    root.walkDecls(/^--color-/, (d) => {
      if (/^#[0-9a-f]+$/i.test(d.value.trim())) palette.set(d.prop, d.value.trim());
    });
    root.walkDecls((d) => {
      if (d.value.includes('oklab')) d.value = rewrite(d.value, palette);
    });
  },
});
module.exports.postcss = true;
