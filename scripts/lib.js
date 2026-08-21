'use strict';
/**
 * Shared library for the topical map build workflow.
 *
 * A map lives in maps/<slug>.json as the single source of truth. This module
 * validates that file, derives everything the viewer needs (the DATA tree, the
 * DETAIL lookup, stat counters, the pillar legend) and renders it into
 * templates/map.html to produce public/<slug>/index.html.
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const MAPS_DIR  = path.join(ROOT, 'maps');
const PUBLIC_DIR= path.join(ROOT, 'public');
const TEMPLATE  = path.join(ROOT, 'templates', 'map.html');

const SITE = 'https://topicalmaps.weissmediamarketing.com';

/** Default pillar colours, applied in order to pillars that don't set one. */
const PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#db2777'];

/** Vocabularies the viewer's legend and panel styling depend on. */
const INTENTS  = ['Informational', 'Commercial', 'Transactional', 'Navigational'];
const PRIOS    = ['High', 'Medium', 'Low'];
const STATUSES = ['Exists', 'Gap', 'Needs Update'];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── small helpers ─────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isLeaf(node) {
  return !Array.isArray(node.children) || node.children.length === 0;
}

/** Depth-first walk yielding [node, ancestors] with ancestors root-first. */
function walk(node, fn, trail = []) {
  fn(node, trail);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, fn, trail.concat([node]));
  }
}

// ── validation ────────────────────────────────────────────────────────────────

class MapError extends Error {}

/**
 * Validate a parsed map document. Returns { errors, warnings } — errors block
 * the build, warnings are printed but don't.
 */
function validate(map, { slugFromFilename } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return { errors: ['map must be a JSON object'], warnings };
  }

  if (typeof map.client !== 'string' || !map.client.trim()) err('"client" is required and must be a non-empty string');
  if (typeof map.slug !== 'string' || !SLUG_RE.test(map.slug)) {
    err('"slug" is required and must be lowercase letters, digits and single hyphens (e.g. "partner-in-aging")');
  } else if (slugFromFilename && map.slug !== slugFromFilename) {
    err(`"slug" is "${map.slug}" but the file is named ${slugFromFilename}.json — they must match`);
  }
  if (map.palette !== undefined && (!Array.isArray(map.palette) || map.palette.some(c => !/^#[0-9a-fA-F]{6}$/.test(c)))) {
    err('"palette", if present, must be an array of #rrggbb colour strings');
  }

  if (!Array.isArray(map.pillars) || map.pillars.length === 0) {
    err('"pillars" is required and must be a non-empty array');
    return { errors, warnings };
  }

  const seenLeaf = new Map();
  map.pillars.forEach((pillar, pi) => {
    const where = (trail, node) => [pillar.name || `pillar[${pi}]`]
      .concat(trail.slice(1).map(n => n.name)).concat([node.name]).join(' › ');

    if (pillar.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(pillar.color)) {
      err(`pillar "${pillar.name || pi}": "color" must be a #rrggbb string`);
    }

    walk(pillar, (node, trail) => {
      const loc = where(trail, node);
      if (typeof node.name !== 'string' || !node.name.trim()) {
        err(`${loc || `pillar[${pi}]`}: every node needs a non-empty "name"`);
        return;
      }
      if (!isLeaf(node)) {
        for (const field of ['intent', 'fmt', 'prio', 'status', 'query', 'desc']) {
          if (node[field] !== undefined) warn(`${loc}: "${field}" is ignored on a branch node (only leaf pages carry page metadata)`);
        }
        return;
      }
      // leaf = a page idea
      for (const field of ['query', 'intent', 'fmt', 'prio', 'status', 'desc']) {
        if (typeof node[field] !== 'string' || !node[field].trim()) {
          err(`${loc}: leaf pages require a non-empty "${field}"`);
        }
      }
      if (node.intent && !INTENTS.includes(node.intent))   err(`${loc}: "intent" must be one of ${INTENTS.join(', ')}`);
      if (node.prio   && !PRIOS.includes(node.prio))       err(`${loc}: "prio" must be one of ${PRIOS.join(', ')}`);
      if (node.status && !STATUSES.includes(node.status))  err(`${loc}: "status" must be one of ${STATUSES.join(', ')}`);
      if (node.status === 'Exists' && !node.url)           warn(`${loc}: status is "Exists" but no "url" is set`);
      if (node.url !== undefined && typeof node.url !== 'string') err(`${loc}: "url" must be a string`);

      // The viewer keys its detail lookup by page title, so titles must be unique.
      if (seenLeaf.has(node.name)) {
        err(`duplicate page title "${node.name}" (also at ${seenLeaf.get(node.name)}) — page titles must be unique across the map`);
      } else {
        seenLeaf.set(node.name, loc);
      }
    });
  });

  if (seenLeaf.size === 0) err('the map contains no leaf pages — every branch bottoms out empty');

  return { errors, warnings };
}

// ── derivation ────────────────────────────────────────────────────────────────

/**
 * Turn a validated map document into everything the template needs.
 * Leaf pages are written once in the source file; DATA and DETAIL are both
 * derived from them, so the two can never drift apart.
 */
function compile(map) {
  const palette = map.palette && map.palette.length ? map.palette : PALETTE;

  const dataPillars = [];
  const detail = {};
  const legend = [];
  let subtopics = 0, ideas = 0, high = 0;

  map.pillars.forEach((pillar, i) => {
    const color = pillar.color || palette[i % palette.length];
    legend.push({ name: pillar.name, color });
    subtopics += (pillar.children || []).length;

    const convert = (node, trail) => {
      if (!isLeaf(node)) {
        return { name: node.name, children: node.children.map(c => convert(c, trail.concat([node.name]))) };
      }
      ideas++;
      if (node.prio === 'High') high++;
      // trail is [pillar, cluster, subcluster, ...] — the viewer shows the first three.
      detail[node.name] = {
        desc: node.desc,
        lt: node.lt || pillar.name,
        intent: node.intent,
        fmt: node.fmt,
        prio: node.prio,
        status: node.status,
        query: node.query,
        url: node.url || '',
        core: trail[0] || '',
        sub: trail[1] || '',
        subsub: trail[2] || ''
      };
      return {
        name: node.name,
        intent: node.intent,
        fmt: node.fmt,
        prio: node.prio,
        status: node.status,
        query: node.query
      };
    };

    dataPillars.push({
      name: pillar.name,
      color,
      children: (pillar.children || []).map(c => convert(c, [pillar.name]))
    });
  });

  return {
    data: { name: map.client, children: dataPillars },
    detail,
    legend,
    palette,
    stats: { topics: map.pillars.length, subtopics, ideas, high }
  };
}

// ── rendering ─────────────────────────────────────────────────────────────────

function render(map, compiled, template) {
  const title = map.title || `${map.client} | Topical Authority Map | Weiss Media Marketing`;
  const png   = map.pngFilename || `${slugify(map.client)}-topical-authority-map.png`;

  const legendHtml = compiled.legend
    .map(p => `<span class="lg"><i style="background:${p.color}"></i>${escapeHtml(p.name)}</span>`)
    .join('');

  const values = {
    TITLE: escapeHtml(title),
    CLIENT: escapeHtml(map.client),
    STAT_TOPICS: String(compiled.stats.topics),
    STAT_SUBTOPICS: String(compiled.stats.subtopics),
    STAT_IDEAS: String(compiled.stats.ideas),
    STAT_HIGH: String(compiled.stats.high),
    LEGEND: legendHtml,
    COLORS: JSON.stringify(compiled.palette),
    DATA: JSON.stringify(compiled.data),
    DETAIL: JSON.stringify(compiled.detail),
    PNG_FILENAME: png
  };

  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const token = `{{${key}}}`;
    if (!out.includes(token)) throw new MapError(`templates/map.html is missing the ${token} placeholder`);
    out = out.split(token).join(value);
  }

  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new MapError(`templates/map.html has an unfilled placeholder: ${leftover[0]}`);
  return out;
}

// ── file-level operations ─────────────────────────────────────────────────────

function mapPath(slug)  { return path.join(MAPS_DIR, `${slug}.json`); }
function outPath(slug)  { return path.join(PUBLIC_DIR, slug, 'index.html'); }

function listMapSlugs() {
  if (!fs.existsSync(MAPS_DIR)) return [];
  return fs.readdirSync(MAPS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

function loadMap(slug) {
  const file = mapPath(slug);
  if (!fs.existsSync(file)) throw new MapError(`no such map: maps/${slug}.json`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new MapError(`maps/${slug}.json is not valid JSON: ${e.message}`);
  }
  return parsed;
}

function loadTemplate() {
  if (!fs.existsSync(TEMPLATE)) throw new MapError('templates/map.html is missing');
  return fs.readFileSync(TEMPLATE, 'utf8');
}

/** Validate + compile + render one map. Throws MapError on validation failure. */
function buildMap(slug, template = loadTemplate()) {
  const map = loadMap(slug);
  const { errors, warnings } = validate(map, { slugFromFilename: slug });
  if (errors.length) {
    throw new MapError(`maps/${slug}.json failed validation:\n  - ${errors.join('\n  - ')}`);
  }
  const compiled = compile(map);
  return { map, compiled, warnings, html: render(map, compiled, template) };
}

/** Regenerate public/index.html as a gallery of every map directory present. */
function renderGallery(entries) {
  const cards = entries.map(e => `    <a class="card" href="/${e.slug}/">
      <span class="name">${escapeHtml(e.client)}</span>
      <span class="slug">/${escapeHtml(e.slug)}</span>
      ${e.stats ? `<span class="meta">${e.stats.topics} core topics &middot; ${e.stats.ideas} content ideas</span>` : '<span class="meta">deployed map</span>'}
    </a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WMM Topical Maps</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',Calibri,sans-serif;min-height:100vh;padding:48px 24px}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:22px;color:#e6edf3;font-weight:700}
h1 small{display:block;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#484f58;font-weight:600;margin-bottom:6px}
.sub{font-size:13px;color:#484f58;margin:8px 0 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{display:block;background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px;text-decoration:none;position:relative;overflow:hidden;transition:border-color .15s}
.card::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:#58a6ff;opacity:.5}
.card:hover{border-color:#58a6ff}
.name{display:block;font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:4px}
.slug{display:block;font-family:monospace;font-size:11px;color:#484f58;margin-bottom:8px}
.meta{display:block;font-size:11px;color:#6e7681}
.empty{border:1px dashed #21262d;border-radius:10px;padding:36px;text-align:center;color:#2a3547;font-size:13px}
footer{margin-top:36px;font-size:11px;color:#2a3547}
footer a{color:#484f58}
</style>
</head>
<body>
<div class="wrap">
  <h1><small>Weiss Media Marketing</small>Topical Maps</h1>
  <p class="sub">${entries.length} published map${entries.length === 1 ? '' : 's'}.</p>
  <div class="grid">
${cards || '    <div class="empty">No maps published yet.</div>'}
  </div>
  <footer>Generated by <code>npm run build</code> &middot; <a href="/admin/">Admin</a></footer>
</div>
</body>
</html>
`;
}

module.exports = {
  ROOT, MAPS_DIR, PUBLIC_DIR, TEMPLATE, SITE, PALETTE,
  INTENTS, PRIOS, STATUSES, SLUG_RE,
  MapError,
  slugify, escapeHtml, isLeaf, walk,
  validate, compile, render,
  mapPath, outPath, listMapSlugs, loadMap, loadTemplate, buildMap, renderGallery
};
