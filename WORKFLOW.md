# Topical map build workflow

Every map is written once as JSON and rendered into the interactive viewer by a
build script. The JSON is the source of truth; `public/<slug>/index.html` is a
build artifact that happens to be committed so Netlify can publish it as a
static file.

```
maps/<slug>.json  ──build──▶  public/<slug>/index.html  ──Netlify──▶  topicalmaps.weissmediamarketing.com/<slug>
       ▲                              ▲
   you edit this            templates/map.html (the viewer shell)
```

Requires Node 18+. There are no dependencies to install.

---

## The five-step loop

```bash
npm run new-map -- "Partner in Aging"      # 1. scaffold maps/partner-in-aging.json
$EDITOR maps/partner-in-aging.json         # 2. write the map
npm run validate                           # 3. catch mistakes before rendering
npm run build                              # 4. render to public/partner-in-aging/index.html
open public/partner-in-aging/index.html    # 5. look at it, then commit both files
```

`npm run new-map` takes either a client name (the slug is derived from it) or an
explicit slug plus a name:

```bash
npm run new-map -- "Partner in Aging"                 # slug: partner-in-aging
npm run new-map -- pia-2026 "Partner in Aging"        # slug: pia-2026
```

Every command accepts specific slugs, and defaults to all maps:

```bash
npm run validate                      # all maps
npm run validate -- danielle-esposito # just one
npm run build -- slug-a slug-b        # rebuild two maps
npm run check                         # build in memory, write nothing (for CI)
npm test                              # round-trip regression check, see below
```

Commit **both** `maps/<slug>.json` and `public/<slug>/index.html`. Netlify
publishes `public/` as-is — it does not run the build — so an uncommitted
rebuild never reaches the live site.

---

## Writing a map

A map is four levels deep below the client:

```
Client                       ← map.client, the root node
└─ Core Topic                ← a pillar; gets its own colour and legend entry
   └─ Subtopic               ← a cluster
      └─ Grouping            ← a sub-cluster
         └─ Page             ← a leaf: one page you would actually publish
```

Only leaves carry page metadata. Branch nodes need nothing but a `name` and
`children`. You can go shallower or deeper than four levels — the viewer draws
whatever tree you give it — but the breadcrumb in the detail panel shows the
first three levels, and the "Subtopics" counter counts the level directly under
each pillar.

### Top-level fields

| Field | Required | Notes |
| --- | --- | --- |
| `slug` | yes | Lowercase letters, digits, single hyphens. Must match the filename and becomes the URL path. |
| `client` | yes | Shown in the header and used as the root node label. |
| `pillars` | yes | Array of core topics. |
| `title` | no | `<title>` tag. Defaults to `<client> \| Topical Authority Map \| Weiss Media Marketing`. |
| `pngFilename` | no | Filename for the Download PNG button. Defaults to a slugified client name. |
| `palette` | no | Array of `#rrggbb` strings assigned to pillars in order. Defaults to the seven-colour house palette. |

### Pillar fields

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Appears in the legend. |
| `children` | yes | Subtopics. |
| `color` | no | `#rrggbb`. Overrides the palette slot for this pillar; every descendant inherits it. |

### Page (leaf) fields

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | The page title. **Must be unique across the whole map** — the viewer keys its detail lookup by title. |
| `query` | yes | The search someone types to land here. |
| `intent` | yes | `Informational`, `Commercial`, `Transactional`, or `Navigational`. |
| `fmt` | yes | Free text, e.g. `Blog Post`, `Guide`, `Listicle`, `Service Page`, `Comparison Page`, `FAQ Page`. |
| `prio` | yes | `High`, `Medium`, or `Low`. |
| `status` | yes | `Exists`, `Gap`, or `Needs Update`. Drives the node's border style. |
| `desc` | yes | "Why this piece" — what job it does in the cluster. |
| `lt` | no | Internal linking target. Defaults to the pillar name. |
| `url` | no | The live URL. Set it whenever `status` is `Exists`. |

A minimal page:

```json
{
  "name": "Perimenopause vs. Menopause: What's Actually Happening to Your Body",
  "query": "difference between perimenopause and menopause",
  "intent": "Informational",
  "fmt": "Blog Post",
  "prio": "High",
  "status": "Gap",
  "desc": "Plain-language explainer separating perimenopause, menopause and post-menopause. The definitional entry point for the cluster."
}
```

`maps/danielle-esposito.json` is a full worked example — 7 pillars, 133 pages.

### What the build derives for you

You never write these; they come out of the tree:

- **Stat counters** — core topics, subtopics, content ideas, high-priority count.
- **The legend** — one entry per pillar, in order, with its colour.
- **Pillar colours** — assigned from the palette unless you set `color`.
- **The breadcrumb** in the detail panel — from each page's position in the tree.
- **The detail lookup** — the viewer needs every page's metadata twice, once in
  the tree and once in a title-keyed lookup. Write it once; the build emits both,
  so the two cannot drift apart.

---

## What validation catches

`npm run validate` (and `npm run build`, which runs the same checks) errors on:

- a missing or malformed `slug`, or one that disagrees with the filename
- a leaf missing any of `query`, `intent`, `fmt`, `prio`, `status`, `desc`
- an `intent`, `prio`, or `status` outside its vocabulary
- **duplicate page titles**, which would silently collapse into one detail entry
- a malformed `color` or `palette` entry
- a map with no pillars, or one whose branches bottom out with no pages

It warns — without blocking — on a page marked `Exists` that has no `url`, and on
page metadata set on a branch node, where it is ignored.

Errors exit non-zero, so `npm run check` works as a CI gate.

---

## Files

| Path | What it is |
| --- | --- |
| `maps/<slug>.json` | Source of truth for one client's map. Hand-edited. |
| `templates/map.html` | The viewer shell: layout, styling, pan/zoom, detail panel, PNG export. Shared by every map. |
| `scripts/lib.js` | Validation, derivation, and rendering. Everything else is a thin CLI over it. |
| `scripts/new-map.js` | Scaffolds a new `maps/<slug>.json`. |
| `scripts/validate.js` | Validates without rendering. |
| `scripts/build.js` | Renders maps and regenerates the gallery at `public/index.html`. |
| `scripts/verify-roundtrip.js` | Regression check (`npm test`), see below. |
| `reference/danielle-esposito.html` | Frozen copy of the hand-built page the template came from. Only the round-trip check reads it. |
| `public/<slug>/index.html` | Build output. Committed so Netlify can serve it. |
| `public/admin/` | The upload-and-deploy admin panel. Not generated. |
| `netlify/functions/maps.js` | Backs the admin panel: lists, deploys, and deletes maps via the GitHub API. |

### The round-trip check

`templates/map.html` was lifted from the page that shipped at
`/danielle-esposito`, and `maps/danielle-esposito.json` was reverse-engineered
from the data embedded in it. `npm test` rebuilds that map and asserts it still
reproduces the original: every non-data line byte for byte, and `DATA` and
`DETAIL` deep-equal. Run it after any edit to the template or to `lib.js` — it is
what tells you a template change broke rendering rather than merely reformatting
it.

---

## Changing the viewer

Edit `templates/map.html`, then `npm run build && npm test`. A template change
affects every map, so rebuild and commit all of them together. The template has
eleven placeholders — `{{TITLE}}`, `{{CLIENT}}`, `{{STAT_TOPICS}}`,
`{{STAT_SUBTOPICS}}`, `{{STAT_IDEAS}}`, `{{STAT_HIGH}}`, `{{LEGEND}}`,
`{{COLORS}}`, `{{DATA}}`, `{{DETAIL}}`, `{{PNG_FILENAME}}` — and the build fails
loudly if one goes missing or one is left unfilled.

---

## The admin panel, and maps not built from source

`public/admin/` uploads a finished HTML file and commits it straight to
`public/<slug>/index.html` through the Netlify function. That path still works and
is untouched by this workflow — it is how the older maps
(`dermeleve`, `partner-in-aging`, `pia3`, `piav2`, …) got here, and they have no
source JSON.

Those maps are not rebuildable, and `npm run build` never touches them. They do
appear in the generated gallery, named from their own `<title>`, but without stat
lines. To bring one into the workflow, write its `maps/<slug>.json` and build over
it.

Two consequences worth knowing:

- A map deployed through the admin panel will not show up in the gallery until
  someone runs `npm run build` and commits the regenerated `public/index.html`.
- If a slug has both a source JSON and an admin-panel upload, the next
  `npm run build` overwrites the upload. Pick one path per map.

## Optionally: build on deploy

To have Netlify render the maps itself instead of serving committed output, set a
build command in `netlify.toml`:

```toml
[build]
  command = "node scripts/build.js"
  publish = "public"
```

That makes a bad map fail the deploy rather than ship a stale page, but it also
means the admin panel's uploads get overwritten on the next deploy for any slug
that has a source JSON. Left off by default.
