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

// ── Ahrefs keyword data (Fan-Out Mapper) ──────────────────────────────────────
// Set AHREFS_API_KEY in Netlify. Tries the REST API v3 first (Enterprise keys);
// on 401/403 falls back to Ahrefs' remote MCP server, which accepts MCP keys
// issued on Lite/Standard/Advanced plans. Override the MCP URL with AHREFS_MCP_URL.
const AHREFS_KEY     = process.env.AHREFS_API_KEY;
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";
const KW_SELECT = "keyword,volume,difficulty,intents,serp_features,parent_topic";
let ahrefsVia = null;       // remembers which transport worked (per warm instance)
let mcpSession = null;

function rawRequest(urlStr, method, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(u, { method, headers: { ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}), ...headers }, timeout: 20000 }, res => {
      let raw = ""; res.setEncoding("utf8");
      res.on("data", d => raw += d);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on("timeout", () => req.destroy(new Error("Ahrefs took too long to respond")));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Ahrefs MCP tool results are text that starts with a JSON object (sometimes followed by more text)
function firstJson(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("No JSON in Ahrefs response");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("Malformed JSON in Ahrefs response");
}

// Parse a JSON-RPC reply that may arrive as plain JSON or as an SSE stream
function parseRpc(res) {
  const ct = String(res.headers["content-type"] || "");
  if (ct.includes("text/event-stream")) {
    const msgs = res.body.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).filter(Boolean)
      .map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(m => m && (m.result || m.error));
    if (!msgs.length) throw new Error("Empty MCP response");
    return msgs[msgs.length - 1];
  }
  return JSON.parse(res.body);
}

async function mcpRpc(method, params, id) {
  const headers = {
    "Authorization": `Bearer ${AHREFS_KEY}`, "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18",
    ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {})
  };
  const body = JSON.stringify(id == null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
  const res = await rawRequest(AHREFS_MCP_URL, "POST", headers, body);
  if (res.status === 404 && mcpSession) { mcpSession = null; throw Object.assign(new Error("MCP session expired"), { retry: true }); }
  if (res.status === 401 || res.status === 403) throw new Error("Ahrefs rejected the key (HTTP " + res.status + "). Check AHREFS_API_KEY.");
  if (res.status >= 400) throw new Error(`Ahrefs MCP returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  if (res.headers["mcp-session-id"]) mcpSession = res.headers["mcp-session-id"];
  return id == null ? null : parseRpc(res);
}

let mcpInitPromise = null;
function mcpInit() {
  if (mcpSession) return Promise.resolve();
  if (!mcpInitPromise) {
    mcpInitPromise = (async () => {
      const r = await mcpRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wmm-fanout-mapper", version: "1.0" } }, 1);
      if (r.error) throw new Error("Ahrefs MCP init failed: " + r.error.message);
      await mcpRpc("notifications/initialized", {}, null);
    })().finally(() => { mcpInitPromise = null; });
  }
  return mcpInitPromise;
}

async function ahrefsViaMcp(tool, args, attempt = 0) {
  await mcpInit();
  try {
    const r = await mcpRpc("tools/call", { name: tool, arguments: args }, Date.now());
    if (r.error) throw new Error("Ahrefs: " + r.error.message);
    const text = (r.result.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    if (r.result.isError) throw new Error("Ahrefs: " + text.slice(0, 300));
    return firstJson(text);
  } catch (e) {
    if (e.retry && attempt === 0) return ahrefsViaMcp(tool, args, 1);
    throw e;
  }
}

async function ahrefsViaApi(path, params) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const res = await rawRequest(`https://api.ahrefs.com/v3/${path}?${qs}`, "GET", { "Authorization": `Bearer ${AHREFS_KEY}`, "Accept": "application/json" });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("API key not allowed"), { fallback: true });
  let data; try { data = JSON.parse(res.body); } catch { data = {}; }
  if (res.status >= 400) throw new Error("Ahrefs: " + (data.error || res.body.slice(0, 200)));
  return data;
}

// tool = MCP tool name, e.g. "keywords-explorer-matching-terms"; REST path derived from it
async function ahrefsCall(tool, params) {
  const path = tool.replace(/^keywords-explorer-/, "keywords-explorer/");
  if (ahrefsVia !== "mcp") {
    try { const d = await ahrefsViaApi(path, params); ahrefsVia = "api"; return d; }
    catch (e) { if (!e.fallback) throw e; ahrefsVia = "mcp"; }
  }
  return ahrefsViaMcp(tool, params);
}

async function ahrefsKeywords({ seed, country, depth }) {
  if (!AHREFS_KEY) throw new Error("AHREFS_API_KEY is not set in Netlify environment variables.");
  if (!seed) throw new Error("seed required");
  const c = (country || "us").toLowerCase();
  const n = Math.max(20, Math.min(300, Number(depth) || 100));
  const base = { select: KW_SELECT, country: c, keywords: seed, order_by: "volume:desc" };
  const jobs = [
    ["matching", "keywords-explorer-matching-terms",  { ...base, limit: n }],
    ["question", "keywords-explorer-matching-terms",  { ...base, terms: "questions", limit: Math.round(n / 2) }],
    ["related",  "keywords-explorer-related-terms",   { ...base, limit: Math.round(n / 2) }]
  ];
  const settled = await Promise.allSettled(jobs.map(([, tool, p]) => ahrefsCall(tool, p)));
  const seen = new Map(), errors = [];
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled") { errors.push(s.reason.message); return; }
    (s.value.keywords || []).forEach(k => {
      const key = String(k.keyword || "").toLowerCase().trim();
      if (!key) return;
      if (!seen.has(key)) seen.set(key, { ...k, sources: [jobs[i][0]] });
      else seen.get(key).sources.push(jobs[i][0]);
    });
  });
  if (!seen.size && errors.length) throw new Error(errors[0]);
  const keywords = [...seen.values()].sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return { country: c, via: ahrefsVia, keywords, errors };
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

  // ── Ahrefs keyword ideas for a seed (Fan-Out Mapper) ─────────────────────
  if (action === "ahrefs-status") {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ configured: !!AHREFS_KEY }) };
  }
  if (action === "ahrefs") {
    try {
      const data = await ahrefsKeywords(body);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    } catch (e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
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
