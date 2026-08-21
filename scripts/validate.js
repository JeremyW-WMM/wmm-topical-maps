#!/usr/bin/env node
'use strict';
/**
 * Validate maps/*.json without building anything.
 *
 *   node scripts/validate.js            validate every map
 *   node scripts/validate.js <slug>     validate one map
 *
 * Errors exit non-zero; warnings are printed and don't.
 */

const lib = require('./lib');

const RESET = '\x1b[0m', DIM = '\x1b[2m', RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m';

function main(argv) {
  const slugs = argv.filter(a => !a.startsWith('-'));
  const targets = slugs.length ? slugs : lib.listMapSlugs();

  if (!targets.length) {
    console.log(`${YEL}No maps found in maps/.${RESET}`);
    return 0;
  }

  let failed = 0, warned = 0;

  for (const slug of targets) {
    let map;
    try {
      map = lib.loadMap(slug);
    } catch (e) {
      console.error(`${RED}✗ ${e.message}${RESET}`);
      failed++;
      continue;
    }

    const { errors, warnings } = lib.validate(map, { slugFromFilename: slug });
    if (errors.length) {
      failed++;
      console.error(`${RED}✗ maps/${slug}.json${RESET}`);
      for (const e of errors) console.error(`  ${RED}error${RESET}  ${e}`);
    } else {
      const s = lib.compile(map).stats;
      console.log(`${GRN}✓${RESET} maps/${slug}.json ${DIM}— ${s.topics} core topics, ${s.subtopics} subtopics, ${s.ideas} content ideas (${s.high} high priority)${RESET}`);
    }
    for (const w of warnings) {
      warned++;
      console.warn(`  ${YEL}warn${RESET}   ${w}`);
    }
  }

  if (failed) {
    console.error(`\n${RED}${failed} of ${targets.length} map${targets.length === 1 ? '' : 's'} invalid.${RESET}`);
    return 1;
  }
  console.log(`\n${GRN}All ${targets.length} map${targets.length === 1 ? '' : 's'} valid.${RESET}${warned ? ` ${YEL}${warned} warning${warned === 1 ? '' : 's'}.${RESET}` : ''}`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
