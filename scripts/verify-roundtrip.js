#!/usr/bin/env node
'use strict';
/**
 * Regression check for the build workflow.
 *
 * templates/map.html was lifted from the hand-built page that shipped at
 * /danielle-esposito, and maps/danielle-esposito.json was reverse-engineered
 * from the data embedded in it. This asserts the two still reproduce that page:
 *
 *   - every non-data line of the rendered output matches the reference byte for byte
 *   - the rendered DATA and DETAIL objects deep-equal the reference ones
 *
 * The build serialises JSON compactly and escapes HTML entities, so the data
 * lines and the legend are compared by meaning rather than by bytes.
 *
 *   node scripts/verify-roundtrip.js
 */

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');
const lib    = require('./lib');

const RESET = '\x1b[0m', DIM = '\x1b[2m', RED = '\x1b[31m', GRN = '\x1b[32m';

const SLUG = 'danielle-esposito';
const REFERENCE = path.join(__dirname, '..', 'reference', `${SLUG}.html`);

/** Pull `const NAME = <json>;` off a page. */
function extractConst(html, name) {
  const line = html.split('\n').find(l => l.startsWith(`const ${name}`));
  assert.ok(line, `${name} not found`);
  return JSON.parse(line.replace(new RegExp(`^const ${name}\\s*=\\s*`), '').replace(/;\s*$/, ''));
}

/** Lines that legitimately differ in formatting: data blobs and the escaped legend. */
function isDataLine(line) {
  return /^const (DATA|DETAIL|COLORS)\s*=/.test(line) || line.includes('class="lg"><i style="background:#');
}

function main() {
  if (!fs.existsSync(REFERENCE)) {
    console.error(`${RED}missing reference/${SLUG}.html — the round-trip check needs the original hand-built page.${RESET}`);
    return 1;
  }

  const reference = fs.readFileSync(REFERENCE, 'utf8');
  const built = lib.buildMap(SLUG).html;

  const checks = [];
  const fail = (msg) => { checks.push([false, msg]); };
  const pass = (msg) => { checks.push([true, msg]); };

  // 1. structural: same line count, and every non-data line identical.
  const a = reference.split('\n'), b = built.split('\n');
  if (a.length !== b.length) {
    fail(`line count differs: reference ${a.length}, built ${b.length}`);
  } else {
    const diffs = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && !isDataLine(a[i])) diffs.push(i + 1);
    }
    if (diffs.length) fail(`${diffs.length} non-data line(s) differ: ${diffs.slice(0, 10).join(', ')}`);
    else pass(`all ${a.length} non-data lines match the reference byte for byte`);
  }

  // 2. semantic: the data the viewer actually reads.
  for (const name of ['DATA', 'DETAIL']) {
    try {
      assert.deepStrictEqual(extractConst(built, name), extractConst(reference, name));
      pass(`${name} deep-equals the reference`);
    } catch (e) {
      fail(`${name} differs from the reference: ${String(e.message).split('\n')[0]}`);
    }
  }

  // 3. the legend names, ignoring HTML escaping.
  const names = (html) => (html.match(/class="lg"><i style="background:#[0-9a-f]{6}"><\/i>[^<]*/g) || [])
    .map(s => s.replace(/^.*<\/i>/, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
  try {
    assert.deepStrictEqual(names(built), names(reference));
    pass('pillar legend matches the reference');
  } catch (e) {
    fail(`pillar legend differs: ${String(e.message).split('\n')[0]}`);
  }

  for (const [ok, msg] of checks) console.log(`${ok ? GRN + '✓' : RED + '✗'}${RESET} ${msg}`);
  const failures = checks.filter(([ok]) => !ok).length;
  if (failures) {
    console.error(`\n${RED}${failures} check(s) failed — templates/map.html and maps/${SLUG}.json no longer reproduce the shipped page.${RESET}`);
    return 1;
  }
  console.log(`\n${GRN}Round-trip verified${RESET} ${DIM}— the workflow reproduces the hand-built ${SLUG} page.${RESET}`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
