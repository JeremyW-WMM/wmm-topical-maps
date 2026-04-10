const https = require("https");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = "JeremyW-WMM/wmm-topical-maps";

function githubRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "WMM-Topical-Maps",
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (!GITHUB_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "GITHUB_TOKEN not set in Netlify environment variables." }) };
  }

  const { action, slug, content } = JSON.parse(event.body || "{}");

  // ── LIST: return all deployed slugs ──────────────────────────────────────
  if (action === "list") {
    const res = await githubRequest("GET", `/repos/${REPO}/contents/public`);
    if (res.status === 404) return { statusCode: 200, headers, body: JSON.stringify({ maps: [] }) };
    if (res.status !== 200) return { statusCode: res.status, headers, body: JSON.stringify({ error: res.data.message }) };

    // Filter to directories that contain an index.html (skip root files like index.html itself)
    const dirs = (res.data || []).filter(i => i.type === "dir");
    const maps = dirs.map(d => ({
      slug: d.name,
      url: `https://topicalmaps.weissmediamarketing.com/${d.name}`
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ maps }) };
  }

  // ── DEPLOY: push a new/updated map ───────────────────────────────────────
  if (action === "deploy") {
    if (!slug || !content) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "slug and content required" }) };
    }

    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    const filePath = `/repos/${REPO}/contents/public/${cleanSlug}/index.html`;

    // Get existing SHA if file exists
    const existing = await githubRequest("GET", filePath);
    const sha = existing.status === 200 ? existing.data.sha : null;

    const pushBody = {
      message: `Deploy topical map: ${cleanSlug}`,
      content, // already base64 from client
      ...(sha ? { sha } : {})
    };

    const result = await githubRequest("PUT", filePath, pushBody);
    if (result.status === 200 || result.status === 201) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true,
          slug: cleanSlug,
          url: `https://topicalmaps.weissmediamarketing.com/${cleanSlug}`
        })
      };
    }
    return { statusCode: result.status, headers, body: JSON.stringify({ error: result.data.message }) };
  }

  // ── DELETE: remove a map ─────────────────────────────────────────────────
  if (action === "delete") {
    if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: "slug required" }) };
    const filePath = `/repos/${REPO}/contents/public/${slug}/index.html`;
    const existing = await githubRequest("GET", filePath);
    if (existing.status !== 200) return { statusCode: 404, headers, body: JSON.stringify({ error: "Map not found" }) };
    const result = await githubRequest("DELETE", filePath, {
      message: `Remove topical map: ${slug}`,
      sha: existing.data.sha
    });
    if (result.status === 200) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    return { statusCode: result.status, headers, body: JSON.stringify({ error: result.data.message }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };
};
