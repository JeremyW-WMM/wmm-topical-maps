const https = require("https");

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPO          = "JeremyW-WMM/wmm-topical-maps";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
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
    const { betas: _betas, ...apiPayload } = payload;
    const data = JSON.stringify(apiPayload);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    };
    // Beta headers: callers may pass `betas: [...]` on the payload (stripped before sending)
    const betas = Array.isArray(payload.betas) ? payload.betas.slice() : [];
    // Only add web search beta header if using the legacy web search tool
    if (payload.tools && payload.tools.some(t => t.type && t.type.includes("web_search_2025"))) {
      betas.push("web-search-2025-03-05");
    }
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    const opts = { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: { error: { message: raw.slice(0, 500) } } }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Page fetcher (for content coverage checks) ────────────────────────────────
const http = require("http");
const PAGE_TEXT_LIMIT = 60000;

function isBlockedHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h.includes(":")) {
    // IPv6 literal: block loopback, unspecified, unique-local, link-local and IPv4-mapped
    return h === "::" || h === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith("::ffff:");
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
         (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function getUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error("Invalid URL")); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error("Only http(s) URLs are supported"));
    if (isBlockedHost(u.hostname)) return reject(new Error("That host is not allowed"));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WMM-FanOutMapper/1.0)", "Accept": "text/html,*/*;q=0.8" },
      timeout: 8000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 4) return reject(new Error("Too many redirects"));
        return resolve(getUrl(new URL(res.headers.location, u).toString(), redirects + 1));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`Page returned HTTP ${res.statusCode}`)); }
      let raw = "", size = 0;
      res.setEncoding("utf8");
      res.on("data", d => { size += d.length; if (size < 3000000) raw += d; else req.destroy(); });
      res.on("end", () => resolve({ html: raw, finalUrl: u.toString() }));
      res.on("close", () => resolve({ html: raw, finalUrl: u.toString() }));
    });
    req.on("timeout", () => req.destroy(new Error("Page took too long to respond")));
    req.on("error", reject);
  });
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

async function fetchPage(url) {
  if (!url) throw new Error("url required");
  const { html, finalUrl } = await getUrl(url);
  const title = decodeEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim());
  const metaDesc = decodeEntities((html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || "");
  const headings = [];
  html.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => {
    const t = decodeEntities(inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (t) headings.push(`H${lvl}: ${t}`);
  });
  let text = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const fullLength = text.length;
  const truncated = fullLength > PAGE_TEXT_LIMIT;
  if (truncated) text = text.slice(0, PAGE_TEXT_LIMIT);
  return { url: finalUrl, title, metaDesc, headings: headings.slice(0, 200), text, truncated, fullLength };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { action } = body;

  // ── Claude proxy (single call, no tool use loops) ─────────────────────────
  if (action === "claude") {
    if (!ANTHROPIC_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables." }) };
    try {
      const res = await anthropicRequest(body.payload);
      return { statusCode: res.status, headers: CORS, body: JSON.stringify(res.data) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── Fetch a public page and return its readable text (Fan-Out Mapper) ─────
  if (action === "fetchpage") {
    try {
      const page = await fetchPage(String(body.url || ""));
      return { statusCode: 200, headers: CORS, body: JSON.stringify(page) };
    } catch (e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── GitHub: list ──────────────────────────────────────────────────────────
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

  // ── GitHub: deploy ────────────────────────────────────────────────────────
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

  // ── GitHub: delete ────────────────────────────────────────────────────────
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
