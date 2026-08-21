# wmm-topical-maps

Interactive topical authority maps for Weiss Media Marketing clients, published
at `topicalmaps.weissmediamarketing.com/<slug>`.

Each map is written once as JSON in `maps/` and rendered into the interactive
viewer by a build script. Requires Node 18+; there are no dependencies.

```bash
npm run new-map -- "Client Name"   # scaffold maps/<slug>.json
npm run validate                   # check every map
npm run build                      # render to public/<slug>/index.html
npm test                           # round-trip regression check
```

See **[WORKFLOW.md](WORKFLOW.md)** for the field reference, what validation
catches, and how the admin panel fits in.
