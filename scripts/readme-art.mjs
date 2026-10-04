#!/usr/bin/env node
/**
 * Render the README's terminal illustrations into assets/.
 *
 * Usage: node scripts/readme-art.mjs
 *
 * Three scenes, each in a light and a dark variant for `<picture>`:
 *
 * - `demo-*.svg`: the skill scene, animated. The eye-catcher under the banner.
 * - `usage-skill-*.svg`: the same scene, static, next to its prompt in Usage.
 * - `usage-mcp-*.svg`: a validator error resolved through `ooxml_explain`,
 *   animated.
 *
 * The animation is CSS inside the SVG, because GitHub serves README images
 * through `<img>`, where CSS animation runs and scripts do not. Every animated
 * element's resting style is its final frame, so a renderer that ignores the
 * animation, or a viewer with reduced motion, sees the finished session.
 *
 * The tool output in each scene is trimmed from real runs of
 * `skill/scripts/ooxml.mjs`, but written out here by hand. Nothing ties it to
 * the CLI: when an answer's shape changes, rerun the command, edit the rows
 * and regenerate.
 */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

const OUT = join(import.meta.dirname, '..', 'assets');
const W = 800;
const PAD = 28;
const FONT =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";
const DOTS = ['#f25022', '#ffb900', '#7fba00'];

const THEMES = {
  light: {
    bg: '#ffffff',
    bar: '#f6f8fa',
    border: '#d0d7de',
    fg: '#1f2328',
    muted: '#656d76',
    faint: '#8c959f',
    box: '#f6f8fa',
    blue: '#0969da',
    green: '#1a7f37',
    yellow: '#9a6700',
    red: '#cf222e',
    accent: '#0078d4',
    addBg: '#dafbe1',
  },
  dark: {
    bg: '#0d1117',
    bar: '#161b22',
    border: '#30363d',
    fg: '#f0f6fc',
    muted: '#9198a1',
    faint: '#6e7681',
    box: '#161b22',
    blue: '#79c0ff',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    accent: '#00a4ef',
    addBg: '#12261e',
  },
};

/** @param {string} s */
const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A run of text in one colour.
 * @param {string} text
 * @param {string} color a THEMES key
 * @param {boolean} [bold]
 */
const seg = (text, color, bold = false) => ({text, color, bold});

/**
 * Keyframes for one element on a looping timeline. Times are seconds into the
 * cycle. The element is hidden until `at`, holds, then fades with the loop.
 * @param {string} id
 * @param {number} at
 * @param {number} cycle
 */
function appear(id, at, cycle) {
  const p = (t) => ((t / cycle) * 100).toFixed(2);
  return (
    `@keyframes ${id}{0%,${p(at)}%{opacity:0;transform:translateY(4px)}` +
    `${p(at + 0.25)}%,95%{opacity:1;transform:none}98.5%,100%{opacity:0}}` +
    `.${id}{animation:${id} ${cycle}s linear infinite}`
  );
}

/**
 * The window every scene sits in, plus the shared stylesheet.
 * @param {{t: Record<string, string>, h: number, title: string, label: string, css: string, body: string}} o
 */
function frame({t, h, title, label, css, body}) {
  const colors = Object.entries(t)
    .map(([k, v]) => `.${k}{fill:${v}}`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" xml:space="preserve" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>
text{font-family:${FONT};font-size:13.5px;white-space:pre}
.b{font-weight:700}
${colors}
${css}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
<path d="M0.5 36V10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10V36Z" fill="${t.bar}"/>
<line x1="0.5" y1="36" x2="${W - 0.5}" y2="36" stroke="${t.border}"/>
${DOTS.map((c, i) => `<circle cx="${20 + i * 18}" cy="18.5" r="5.5" fill="${c}"/>`).join('')}
<text x="${W / 2}" y="23" text-anchor="middle" class="muted" style="font-size:12px">${esc(title)}</text>
${body}
</svg>
`;
}

// ---------------------------------------------------------------------------
// The skill scene: look up w:ind, then ST_TwipsMeasure, then write the edit.

const LH = 21;
const CW = 13.5 * 0.6;

/**
 * Rows of the skill scene. `at` is when the row appears in the animated
 * variant; `type` marks a prompt line to be typed out rather than faded in;
 * `pulse` marks a tool call whose bullet blinks until its output arrives.
 * @type {Array<null | {segs: ReturnType<typeof seg>[], ind?: number, deco?: 'prompt' | 'add', at: number, type?: number, pulse?: number}>}
 */
const SKILL = [
  {
    segs: [
      seg('> ', 'faint'),
      seg('Add a first-line indent to the paragraphs in our .docx export.', 'fg'),
    ],
    deco: 'prompt',
    at: 0.4,
    type: 2.0,
  },
  {
    segs: [seg('  ', 'faint'), seg('Check the schema before you write the XML.', 'fg')],
    deco: 'prompt',
    at: 2.5,
    type: 1.4,
  },
  null,
  {segs: [seg('● ', 'blue'), seg('Skill', 'fg', true), seg('(ooxml-lookup)', 'muted')], at: 4.4},
  null,
  {
    segs: [
      seg('● ', 'green'),
      seg('Bash', 'fg', true),
      seg('(node scripts/ooxml.mjs attributes w:CT_Ind)', 'muted'),
    ],
    at: 5.1,
    pulse: 6.1,
  },
  {segs: [seg('└ ', 'faint'), seg('12 attributes, all optional', 'muted')], ind: 2, at: 6.1},
  {segs: [seg('firstLine   ', 'fg', true), seg('s:ST_TwipsMeasure', 'yellow')], ind: 4, at: 6.25},
  {segs: [seg('hanging     ', 'fg'), seg('s:ST_TwipsMeasure', 'muted')], ind: 4, at: 6.4},
  {segs: [seg('left        ', 'fg'), seg('w:ST_SignedTwipsMeasure', 'muted')], ind: 4, at: 6.55},
  {segs: [seg('… 9 more', 'faint')], ind: 4, at: 6.7},
  null,
  {
    segs: [
      seg('● ', 'green'),
      seg('Bash', 'fg', true),
      seg('(node scripts/ooxml.mjs values s:ST_TwipsMeasure)', 'muted'),
    ],
    at: 7.5,
    pulse: 8.5,
  },
  {segs: [seg('└ ', 'faint'), seg('one of', 'muted')], ind: 2, at: 8.5},
  {
    segs: [seg('s:ST_UnsignedDecimalNumber     ', 'fg'), seg('xsd:unsignedLong', 'yellow')],
    ind: 4,
    at: 8.65,
  },
  {
    segs: [
      seg('s:ST_PositiveUniversalMeasure  ', 'fg'),
      seg('[0-9]+(\\.[0-9]+)?(mm|cm|in|pt|pc|pi)', 'yellow'),
    ],
    ind: 4,
    at: 8.8,
  },
  null,
  {
    segs: [
      seg('● ', 'fg'),
      seg('firstLine takes plain twips or a number with one of six units.', 'fg'),
    ],
    at: 9.8,
  },
  null,
  {
    segs: [seg('● ', 'green'), seg('Edit', 'fg', true), seg('(src/export/paragraph.ts)', 'muted')],
    at: 10.8,
  },
  {
    segs: [
      seg('+ ', 'green', true),
      seg('<w:ind ', 'fg'),
      seg('w:firstLine', 'blue'),
      seg('=', 'fg'),
      seg('"0.5in"', 'green', true),
      seg('/>', 'fg'),
    ],
    ind: 2,
    deco: 'add',
    at: 11.2,
  },
];
const SKILL_CYCLE = 17;

/**
 * @param {Record<string, string>} t
 * @param {boolean} animate
 */
function skillScene(t, animate) {
  const y0 = 54;
  const h = y0 + SKILL.length * LH + 22;
  const body = [];
  const css = [];
  const p = (s) => ((s / SKILL_CYCLE) * 100).toFixed(2);

  const prompt = SKILL.flatMap((r, i) => (r?.deco === 'prompt' ? [i] : []));
  const box = `x="${PAD - 12}" y="${y0 + prompt[0] * LH - 2}" width="${W - 2 * PAD + 24}" height="${prompt.length * LH + 8}" rx="6"`;
  body.push(`<rect ${box} fill="${t.box}" stroke="${t.border}"/>`);
  if (animate) body.push(`<clipPath id="pc"><rect ${box}/></clipPath>`);

  SKILL.forEach((r, i) => {
    if (!r) return;
    const id = `r${i}`;
    const x = PAD + (r.ind ?? 0) * CW;
    const y = y0 + i * LH + LH - 6 + (r.deco === 'prompt' ? 4 : 0);
    const parts = [];
    if (r.deco === 'add') {
      parts.push(
        `<rect x="${x - 6}" y="${y0 + i * LH}" width="${W - PAD - x + 12}" height="${LH}" rx="4" fill="${t.addBg}"/>`,
      );
    }
    const spans = r.segs.map((s, j) => {
      const cls = [s.color, s.bold && 'b', j === 0 && r.pulse && animate && `${id}p`];
      return `<tspan class="${cls.filter(Boolean).join(' ')}">${esc(s.text)}</tspan>`;
    });
    parts.push(`<text x="${x}" y="${y}">${spans.join('')}</text>`);

    if (!animate) {
      body.push(parts.join(''));
      return;
    }
    if (r.type) {
      // Typed out: a box-coloured cover slides off the line one character at
      // a time. Resting state is no cover, so a static render shows the text.
      const chars = r.segs.reduce((n, s) => n + s.text.length, 0);
      const from = r.at;
      const to = r.at + r.type;
      parts.push(
        `<g clip-path="url(#pc)"><rect class="${id}c" x="${x + 2 * CW}" y="${y - LH + 6}" width="${W - PAD - x}" height="${LH}" fill="${t.box}"/></g>`,
      );
      css.push(
        `.${id}c{opacity:0;animation:${id}c ${SKILL_CYCLE}s linear infinite}` +
          `@keyframes ${id}c{0%,${p(from)}%{opacity:1;transform:none;animation-timing-function:steps(${chars - 2})}` +
          `${p(to)}%{opacity:1;transform:translateX(${((chars - 2) * CW).toFixed(1)}px)}${p(to + 0.01)}%,100%{opacity:0}}`,
      );
      body.push(`<g class="${id}">${parts.join('')}</g>`);
      css.push(
        `@keyframes ${id}{0%,${p(from - 0.01)}%{opacity:0}${p(from)}%,95%{opacity:1}98.5%,100%{opacity:0}}` +
          `.${id}{animation:${id} ${SKILL_CYCLE}s linear infinite}`,
      );
      return;
    }
    if (r.pulse) {
      css.push(
        `.${id}p{animation:${id}p ${SKILL_CYCLE}s steps(1) infinite}` +
          `@keyframes ${id}p{0%{opacity:1}${blinks(r.at, r.pulse, p)}${p(r.pulse)}%,100%{opacity:1}}`,
      );
    }
    body.push(`<g class="${id}">${parts.join('')}</g>`);
    css.push(appear(id, r.at, SKILL_CYCLE));
  });

  return frame({
    t,
    h,
    title: '~/report-export · agent',
    label:
      'An agent loads ooxml-lookup, asks which attributes w:ind takes and which values firstLine accepts, then writes w:firstLine="0.5in".',
    css: css.join('\n'),
    body: body.join('\n'),
  });
}

/**
 * Keyframe stops that blink a bullet off and on between two times.
 * @param {number} from
 * @param {number} to
 * @param {(s: number) => string} p
 */
function blinks(from, to, p) {
  const stops = [];
  for (let s = from + 0.25, on = false; s < to; s += 0.25, on = !on) {
    stops.push(`${p(s)}%{opacity:${on ? 1 : 0.2}}`);
  }
  return stops.join('');
}

// ---------------------------------------------------------------------------
// The MCP scene: a pasted validator error resolved through ooxml_explain.

const MCP_CYCLE = 16;

/** @param {Record<string, string>} t */
function mcpScene(t) {
  const els = [];
  const css = [];
  let n = 0;
  /**
   * @param {number} at
   * @param {string} markup
   */
  const add = (at, markup) => {
    const id = `a${n++}`;
    els.push(`<g class="${id}">${markup}</g>`);
    css.push(appear(id, at, MCP_CYCLE));
  };
  /**
   * @param {number} x
   * @param {number} y
   * @param {string} inner
   */
  const tx = (x, y, inner) => `<text x="${x}" y="${y}" class="fg">${inner}</text>`;
  /**
   * @param {string} s
   * @param {string} cls
   */
  const sp = (s, cls) => `<tspan class="${cls}">${esc(s)}</tspan>`;

  const uy = 70;
  add(
    0.3,
    `<rect x="24" y="${uy - 18}" width="${W - 48}" height="66" rx="8" fill="${t.box}" stroke="${t.border}"/>` +
      tx(40, uy, sp('you', 'muted')) +
      tx(40, uy + 20, esc("Word won't open report.docx. The validator says:")) +
      tx(40, uy + 38, sp("Sch_UndeclaredAttribute: The 'bogus' attribute is not declared.", 'red')),
  );

  const cy = 150;
  add(1.6, tx(24, cy, `${sp('●', 'accent')} ${sp('agent', 'muted')}`));
  add(
    2.0,
    `<rect x="24" y="${cy + 10}" width="${W - 48}" height="226" rx="8" fill="${t.bg}" stroke="${t.border}"/>` +
      `<path d="M24.5 ${cy + 38}V${cy + 18}a8 8 0 0 1 8-8h${W - 65}a8 8 0 0 1 8 8V${cy + 38}Z" fill="${t.box}"/>` +
      tx(
        40,
        cy + 29,
        `${sp('tool', 'muted')} ${sp('ooxml_explain', 'accent')}${sp('  (mcp-server-ooxml)', 'muted')}`,
      ) +
      tx(
        40,
        cy + 58,
        sp('id', 'blue') + sp(': ', 'muted') + sp('"Sch_UndeclaredAttribute"', 'green'),
      ) +
      tx(
        40,
        cy + 76,
        sp('xpath', 'blue') +
          sp(': ', 'muted') +
          sp('"/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]"', 'green'),
      ) +
      `<line x1="40" x2="${W - 40}" y1="${cy + 90}" y2="${cy + 90}" stroke="${t.border}"/>`,
  );

  // "running…" shows only while the call is in flight. Its resting style is
  // hidden, so the static frame does not claim the call is still running.
  const p = (s) => ((s / MCP_CYCLE) * 100).toFixed(2);
  els.push(`<g class="run">${tx(40, cy + 112, sp('running…', 'muted'))}</g>`);
  css.push(
    `.run{opacity:0;animation:run ${MCP_CYCLE}s linear infinite}` +
      `@keyframes run{0%,${p(2.6)}%{opacity:0}${p(2.8)}%,${p(3.6)}%{opacity:1}${p(3.65)}%,100%{opacity:0}}`,
  );

  const result = [
    sp('resolved', 'blue') + sp(': ', 'muted') + sp('true', 'green'),
    sp('finding', 'blue') +
      sp(': ', 'muted') +
      sp('undeclared_attribute ', 'fg') +
      sp('"bogus"', 'red'),
    sp('legal.resolved_from', 'blue') + sp(': ', 'muted') + sp('"w:ind -> w:CT_Ind"', 'green'),
    sp('message', 'blue') +
      sp(': ', 'muted') +
      sp(`"The 'bogus' attribute is not allowed on w:ind. …"`, 'green'),
    sp('legal.attributes', 'blue') +
      sp(' (12): ', 'muted') +
      sp('end endChars firstLine firstLineChars hanging hangingChars', 'fg'),
    sp(' '.repeat(23), 'muted') + sp('left leftChars right rightChars start startChars', 'fg'),
    sp('firstLine', 'blue') +
      sp(': ', 'muted') +
      sp('s:ST_TwipsMeasure', 'fg') +
      sp('  optional', 'muted'),
  ];
  result.forEach((m, i) => {
    add(3.7 + i * 0.35, tx(40, cy + 112 + i * 18, m));
  });

  const ry = cy + 262;
  add(7.0, tx(24, ry, `${sp('●', 'accent')} ${sp('agent', 'muted')}`));
  add(
    7.4,
    tx(24, ry + 22, esc("w:bogus isn't an attribute of w:ind, so I removed it. For a first-line")),
  );
  add(
    7.8,
    tx(
      24,
      ry + 40,
      esc('indent the schema allows ') +
        sp('w:firstLine="720"', 'green') +
        esc(' (twips) or ') +
        sp('"0.5in"', 'green') +
        esc('.'),
    ),
  );

  return frame({
    t,
    h: ry + 64,
    title: 'agent · mcp: ooxml',
    label:
      'An agent is given a validator error, calls the ooxml_explain MCP tool, and removes the undeclared attribute.',
    css: css.join('\n'),
    body: els.join('\n'),
  });
}

// ---------------------------------------------------------------------------

for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `demo-${name}.svg`), skillScene(t, true));
  writeFileSync(join(OUT, `usage-skill-${name}.svg`), skillScene(t, false));
  writeFileSync(join(OUT, `usage-mcp-${name}.svg`), mcpScene(t));
}
console.log(`wrote 6 SVGs to ${OUT}`);
