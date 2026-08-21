#!/usr/bin/env node
'use strict';
/**
 * Scaffold a new map source file.
 *
 *   node scripts/new-map.js <slug> "<Client Name>"
 *   node scripts/new-map.js "Partner in Aging"        (slug derived from the name)
 *
 * Writes maps/<slug>.json pre-filled with one worked pillar so the shape is
 * obvious, then tells you what to do next. Never overwrites an existing file.
 */

const fs  = require('fs');
const lib = require('./lib');

const RESET = '\x1b[0m', DIM = '\x1b[2m', RED = '\x1b[31m', GRN = '\x1b[32m';

function skeleton(slug, client) {
  return {
    slug,
    client,
    pillars: [
      {
        name: 'First Core Topic',
        children: [
          {
            name: 'A Subtopic Under It',
            children: [
              {
                name: 'A Narrower Grouping',
                children: [
                  {
                    name: 'The Page Title Someone Would Actually Click',
                    query: 'the search someone types to land here',
                    intent: 'Informational',
                    fmt: 'Blog Post',
                    prio: 'High',
                    status: 'Gap',
                    desc: 'Why this piece exists and what job it does in the cluster.'
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

function main(argv) {
  const args = argv.filter(a => !a.startsWith('-'));
  if (!args.length) {
    console.error(`${RED}usage: npm run new-map -- <slug> "<Client Name>"${RESET}`);
    return 1;
  }

  let slug, client;
  if (args.length === 1) {
    client = args[0];
    slug = lib.slugify(client);
  } else {
    slug = lib.slugify(args[0]);
    client = args.slice(1).join(' ');
  }

  if (!lib.SLUG_RE.test(slug)) {
    console.error(`${RED}"${slug}" is not a usable slug — use lowercase letters, digits and hyphens.${RESET}`);
    return 1;
  }

  const file = lib.mapPath(slug);
  if (fs.existsSync(file)) {
    console.error(`${RED}maps/${slug}.json already exists — edit it, or pick another slug.${RESET}`);
    return 1;
  }

  fs.mkdirSync(lib.MAPS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(skeleton(slug, client), null, 2) + '\n');

  console.log(`${GRN}✓${RESET} created maps/${slug}.json`);
  console.log(`
${DIM}Next:${RESET}
  1. Fill in maps/${slug}.json — one entry per page idea. See WORKFLOW.md for the field reference.
  2. npm run validate -- ${slug}
  3. npm run build -- ${slug}
  4. Open public/${slug}/index.html in a browser to check it.
  5. Commit maps/${slug}.json and public/${slug}/index.html; Netlify publishes ${lib.SITE}/${slug}
`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
