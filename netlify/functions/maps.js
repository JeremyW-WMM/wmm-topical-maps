const https = require("https");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPO = "JeremyW-WMM/wmm-topical-maps";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function request(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname, path, method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        ...headers
      }
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: { raw } }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function ghRequest(method, path, body = null) {
  return request("api.github.com", path, method, {
    "Authorization": `token ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "WMM-Topical-Maps"
  }, body);
}

function anthropicRequest(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const opts = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      }
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: { error: { message: raw } } }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { action } = body;

  if (action === "claude") {
    if (!ANTHROPIC_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables." }) };
    try {
      const res = await anthropicRequest(body.payload);
      return { statusCode: res.status, headers: CORS, body: JSON.stringify(res.data) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (action === "list") {
    if (!GITHUB_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GITHUB_TOKEN not set." }) };
    const res = await ghRequest("GET", `/repos/${REPO}/contents/public`);
    if (res.status === 404) return { statusCode: 200, headers: CORS, body: JSON.stringify({ maps: [] }) };
    if (res.status !== 200) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: res.data.message }) };
    const maps = (res.data || []).filter(i => i.type === "dir").map(d => ({
      slug: d.name,
      url: `https://topicalmaps.weissmediamarketing.com/${d.name}`
    }));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ maps }) };
  }

  if (action === "deploy") {
    if (!GITHUB_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GITHUB_TOKEN not set." }) };
    const { slug, content } = body;
    if (!slug || !content) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "slug and content required" }) };
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    const filePath = `/repos/${REPO}/contents/public/${cleanSlug}/index.html`;
    const existing = await ghRequest("GET", filePath);
    const sha = existing.status === 200 ? existing.data.sha : null;
    const result = await ghRequest("PUT", filePath, {
      message: `Deploy topical map: ${cleanSlug}`,
      content,
      ...(sha ? { sha } : {})
    });
    if (result.status === 200 || result.status === 201) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, slug: cleanSlug, url: `https://topicalmaps.weissmediamarketing.com/${cleanSlug}` }) };
    }
    return { statusCode: result.status, headers: CORS, body: JSON.stringify({ error: result.data.message }) };
  }

  if (action === "delete") {
    if (!GITHUB_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GITHUB_TOKEN not set." }) };
    const { slug } = body;
    if (!slug) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "slug required" }) };
    const filePath = `/repos/${REPO}/contents/public/${slug}/index.html`;
    const existing = await ghRequest("GET", filePath);
    if (existing.status !== 200) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Map not found" }) };
    const result = await ghRequest("DELETE", filePath, { message: `Remove topical map: ${slug}`, sha: existing.data.sha });
    if (result.status === 200) return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    return { statusCode: result.status, headers: CORS, body: JSON.stringify({ error: result.data.message }) };
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Unknown action" }) };
};
