#!/usr/bin/env node
'use strict';
/**
 * Build topical maps from maps/*.json into public/<slug>/index.html.
 *
 *   node scripts/build.js                 build every map + regenerate the gallery
 *   node scripts/build.js <slug> [<slug>] build just those maps + the gallery
 *   node scripts/build.js --check         build in memory only; write nothing
 *
 * Exits non-zero if any map fails validation, so it is safe to run in CI or as
 * a Netlify build command.
 */

const fs   = require('fs');
const path = require('path');
const lib  = require('./lib');

const RESET = '\x1b[0m', DIM = '\x1b[2m', RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m';

function main(argv) {
  const check = argv.includes('--check');
  const slugs = argv.filter(a => !a.startsWith('-'));
  const targets = slugs.length ? slugs : lib.listMapSlugs();

  if (!targets.length) {
    console.log(`${YEL}No maps found in maps/. Create one with: npm run new-map -- <slug> "<Client Name>"${RESET}`);
    return 0;
  }

  let template;
  try {
    template = lib.loadTemplate();
  } catch (e) {
    console.error(`${RED}${e.message}${RESET}`);
    return 1;
  }

  let failed = 0;
  const built = [];

  for (const slug of targets) {
    let result;
    try {
      result = lib.buildMap(slug, template);
    } catch (e) {
      if (!(e instanceof lib.MapError)) throw e;
      console.error(`${RED}✗ ${e.message}${RESET}`);
      failed++;
      continue;
    }

    for (const w of result.warnings) console.warn(`${YEL}  ! ${slug}: ${w}${RESET}`);

    const dest = lib.outPath(slug);
    const { topics, subtopics, ideas, high } = result.compiled.stats;
    const summary = `${topics} core topics, ${subtopics} subtopics, ${ideas} content ideas (${high} high priority)`;

    if (check) {
      console.log(`${GRN}✓${RESET} ${slug} ${DIM}— ${summary} (--check, not written)${RESET}`);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, result.html);
      console.log(`${GRN}✓${RESET} ${slug} ${DIM}— ${summary} → public/${slug}/index.html${RESET}`);
    }
    built.push({ slug, client: result.map.client, stats: result.compiled.stats });
  }

  if (!check && !failed) writeGallery(built);

  if (failed) {
    console.error(`\n${RED}${failed} map${failed === 1 ? '' : 's'} failed to build.${RESET}`);
    return 1;
  }
  console.log(`\n${GRN}Built ${built.length} map${built.length === 1 ? '' : 's'}.${RESET}`);
  return 0;
}

/**
 * The gallery lists every directory under public/ that holds an index.html,
 * not just the ones with a source JSON — maps pushed straight from the admin
 * panel still show up, they just carry no stat line.
 */
function writeGallery(built) {
  const byslug = new Map(built.map(b => [b.slug, b]));
  const entries = fs.readdirSync(lib.PUBLIC_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'admin')
    .map(d => d.name)
    .filter(slug => fs.existsSync(path.join(lib.PUBLIC_DIR, slug, 'index.html')))
    .sort()
    .map(slug => {
      const b = byslug.get(slug);
      if (b) return b;
      // Not built from source — try to name it from its own <title>, else the slug.
      const html = fs.readFileSync(path.join(lib.PUBLIC_DIR, slug, 'index.html'), 'utf8');
      const m = html.match(/<title>([^<]*)<\/title>/);
      const client = m ? m[1].split(/\s*[|–—]\s*/)[0].trim() : slug;
      return { slug, client: client || slug, stats: null };
    });

  fs.writeFileSync(path.join(lib.PUBLIC_DIR, 'index.html'), lib.renderGallery(entries));
  console.log(`${GRN}✓${RESET} gallery ${DIM}— ${entries.length} maps → public/index.html${RESET}`);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
