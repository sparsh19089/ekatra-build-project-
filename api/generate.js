/**
 * api/generate.js — opener3 · Vercel Node.js Serverless Function · ZERO dependencies.
 *
 * POST { "url": "https://example.com" }
 *   → 200 { opener, scrapedPreview, latencyMs, mode, model, words, scrapeMs, scrapedChars, signals, note }
 *   → 4xx/422 { error, step, latencyMs }   (step: "validate" | "scrape" | "draft")
 *
 * Pipeline: CODE normalize → CODE scrape (Jina, 8s cap) → CODE slice 4,000 chars
 *           → CODE regex signals → MODEL phrase 3 lines (optional) → CODE guardrails
 *           → CODE heuristic fallback. The model proposes; the code disposes.
 *
 * Env (all optional — the function still works with none of them):
 *   LLM_API_KEY   OpenRouter (sk-or-…) or Groq (gsk_…, auto-detected) or any OpenAI-compatible key
 *   LLM_BASE_URL  override endpoint   LLM_MODEL  override model
 *   JINA_API_KEY  free key → ~500 RPM scrape budget instead of ~20 RPM keyless
 *
 * Defaults (Nov 2026): Groq retired llama-3.3-70b-versatile from free tiers (→ openai/gpt-oss-120b);
 * OpenRouter's qwen-2.5-72b slug is paid. `openrouter/free` is a router that always picks a live
 * free model, so this default never rots. Override with LLM_BASE_URL / LLM_MODEL at will.
 */

const READER = "https://r.jina.ai/";
const CONTEXT_LIMIT = 4000;          // ~1,000 tokens: value prop + pricing, near-zero cost
const WORD_LIMIT = 55;
const SCRAPE_TIMEOUT_MS = 8000;
const LLM_TIMEOUT_MS = 15000;

const BANNED = ["impressed by", "game-changer", "game changer", "game-changing", "streamline",
  "elevate", "synergy", "revolutionize", "supercharge", "unlock", "thrilled",
  "hope this finds you", "i came across", "reaching out"];

const FREE_DISPLAY = {
  "free up to": "free tier", "free to start": "free plan", "free to try": "free trial",
  "free forever": "free-forever plan", "no credit card": "no-card signup",
  "no credit card required": "no-card signup",
};

const CATEGORIES = {
  scheduling: ["scheduling", "calendar", "booking", "appointment"],
  analytics: ["analytics", "session replay", "feature flag", "product analytics", "funnel"],
  links: ["short link", "link management", "qr code", "utm", "link-in-bio", "short url"],
  devtool: ["api-first", "sdk", "webhook", "deploy", "developer platform", "infrastructure"],
};

const SYSTEM_PROMPT = [
  "You write the first 3 lines of a cold email to a startup founder. Hard rules:",
  "- Exactly 3 lines. Max 55 words total. No subject line, no greeting, no sign-off, no numbering, no surrounding quotes.",
  "- Line 1: one specific, verifiable fact from the website context (ICP, pricing, or a concrete product mechanism). Never invent facts.",
  "- Line 2: connect that fact to an operational or growth bottleneck faced by software companies doing $10K-$50K/month.",
  "- Line 3: one sharp, low-friction question.",
  "- Banned phrases (never use): impressed by, game-changer, game changer, streamline, elevate, synergy, revolutionize, supercharge, unlock, thrilled, hope this finds you, I came across, reaching out.",
  "- Plain, direct, peer-to-peer tone. Output only the 3 lines.",
].join("\n");

/* ----------------------------- tiny utilities ----------------------------- */
const wc = (t) => (t.match(/\S+/g) || []).length;
const hasBanned = (t) => BANNED.find((b) => t.toLowerCase().includes(b)) || null;
const capWords = (s, n) => { const w = s.split(/\s+/); return w.slice(0, n).join(" ") + (w.length > n ? "..." : ""); };
const stripInline = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`~#>]+/g, "").trim();

function httpError(status, message, step) {
  const e = new Error(message);
  e.status = status;
  e.step = step;
  return e;
}

/* ----------------------------- STEP 1a: normalize (CODE) ----------------------------- */
function normalizeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048)
    throw httpError(400, 'Send JSON like { "url": "https://example.com" }.', "validate");
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { throw httpError(400, "That doesn't parse as a URL.", "validate"); }
  const host = u.hostname.toLowerCase();
  // Input hygiene: Jina does the fetching, but reject junk/private targets anyway.
  if (!host.includes(".") || /^(localhost|.*\.local)$/.test(host) ||
      /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":"))
    throw httpError(400, "Public website URLs only (no localhost or IP literals).", "validate");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/* ----------------------------- STEP 1b: scrape (CODE) ----------------------------- */
function parseReader(text) {
  // Jina serves JSON when asked (Accept header) — title/description/content — and falls
  // back to its plain "Title: / URL Source: / Markdown Content:" contract. Handle both.
  try {
    let d = JSON.parse(text);
    if (d && d.data) d = d.data;
    if (d && d.content) return { title: (d.title || "").trim(), description: (d.description || "").trim(), content: d.content };
  } catch { /* plain-text path below */ }
  const tm = text.match(/^Title:\s*(.*)$/m);
  const dm = text.match(/^Description:\s*(.*)$/m);
  const body = text.includes("Markdown Content:") ? text.split("Markdown Content:").slice(1).join("Markdown Content:") : text;
  return { title: tm ? tm[1].trim() : "", description: dm ? dm[1].trim() : "", content: body.trim() };
}

async function scrape(url) {
  const headers = { Accept: "application/json" };
  const jinaKey = (process.env.JINA_API_KEY || "").trim();
  if (jinaKey) headers.Authorization = "Bearer " + jinaKey;
  let res;
  try {
    res = await fetch(READER + url, { headers, signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    throw httpError(422, timedOut
      ? "Scrape timed out after 8s — the site may be JS-heavy or slow. Try again."
      : "Couldn't reach Jina Reader (" + (e.message || "network error") + ").", "scrape");
  }
  if (!res.ok) {
    throw httpError(422, res.status === 429
      ? "Jina Reader is rate-limited right now (keyless ≈ 20 req/min per IP, and Vercel egress IPs are shared). Retry in ~30s, or set a free JINA_API_KEY."
      : "The target site blocked scraping (HTTP " + res.status + " via Jina Reader). Nothing was invented.", "scrape");
  }
  const page = parseReader(await res.text());
  if (!page.content) throw httpError(422, "The scrape returned no readable content (empty or fully scripted page).", "scrape");
  return page;
}

/* ----------------------------- STEP 1c: signals (CODE) ----------------------------- */
function leadParagraph(content) {
  for (const line of content.split("\n")) {
    const s = stripInline(line);
    if (s.length >= 40 && !/^\s*[#!\[|\-]/.test(line)) return s.slice(0, 240);
  }
  return "";
}

function guessCompany(url, title) {
  if (title) {
    const head = title.split(/[|·–—:\-]/)[0].trim();
    if (head && head.split(/\s+/).length <= 3 && head.length <= 24) return head;
  }
  const root = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
}

function extractSignals(page, url) {
  const content = page.content;
  const low = content.toLowerCase();
  const h1m = content.match(/^#\s+(.+)$/m);
  const h1 = h1m ? stripInline(h1m[1]).slice(0, 90) : "";
  const description = page.description || leadParagraph(content);
  const priceRe = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,6})?)((?:\s*\/\s*(?:month|mo|year|yr|user|seat|event|request|credit)s?){1,2}|\s+per\s+(?:month|user|seat|year|event))?/gi;
  const seen = new Set();
  const found = [];
  for (const m of content.matchAll(priceRe)) {
    const val = m[1];
    if (parseFloat(val.replace(/,/g, "")) === 0) continue;
    const unit = (m[2] || "").toLowerCase().replace(/\s+/g, "").replace(/per/g, "/").replace(/\/month/g, "/mo").replace(/\/year/g, "/yr");
    const norm = "$" + val + (unit.startsWith("/") ? unit : "");
    if (!seen.has(norm)) { seen.add(norm); found.push({ norm, unit: !!unit, pos: m.index }); }
  }
  const prices = found.sort((a, b) => (a.unit === b.unit ? a.pos - b.pos : a.unit ? -1 : 1)).slice(0, 3).map((p) => p.norm);
  const fm = low.match(/\b(free (?:plan|tier|trial|forever|version|up to)|no credit card(?: required)?|free to (?:start|try))\b/);
  const scores = Object.entries(CATEGORIES)
    .map(([k, ws]) => [k, ws.reduce((a, w) => a + low.split(w).length - 1, 0)])
    .sort((a, b) => b[1] - a[1]);
  return {
    company: guessCompany(url, page.title), domain: new URL(url).hostname.replace(/^www\./, ""),
    h1, description, prices, free_tier: fm ? fm[1] : "",
    open_source: /open[- ]source/.test(low), category: scores[0][1] > 0 ? scores[0][0] : "generic",
  };
}

/* ----------------------------- STEP 2: model (MODEL — the only AI step) ----------------------------- */
function resolveLLM() {
  const key = (process.env.LLM_API_KEY || "").trim();
  let base = (process.env.LLM_BASE_URL || "").trim();
  let model = (process.env.LLM_MODEL || "").trim();
  if (!base) base = key.startsWith("gsk_") ? "https://api.groq.com/openai/v1" : "https://openrouter.ai/api/v1";
  if (!model) model = base.includes("groq") ? "openai/gpt-oss-120b" : base.includes("dashscope") ? "qwen-plus" : "openrouter/free";
  return { key, base: base.replace(/\/+$/, ""), model };
}

async function llmDraft(context, sig, url, cfg) {
  const body = {
    model: cfg.model, temperature: 0.5, max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Company: " + sig.company + "\nURL: " + url +
        "\nExtracted signals (JSON): " + JSON.stringify(sig) +
        "\n\nWebsite context (first " + CONTEXT_LIMIT + " chars):\n" + context +
        "\n\nWrite the 3 lines now." },
    ],
  };
  if (cfg.base.includes("groq") && /gpt-oss/.test(cfg.model)) body.reasoning_effort = "low";
  if (cfg.base.includes("openrouter")) body.reasoning = { effort: "low" };
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key };
  if (cfg.base.includes("openrouter")) {
    headers["HTTP-Referer"] = "https://" + (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "github.com");
    headers["X-Title"] = "opener3";
  }
  const res = await fetch(cfg.base + "/chat/completions", {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("LLM HTTP " + res.status + (res.status === 429 ? " (free-tier rate limit)" : res.status === 401 ? " (bad key)" : ""));
  const j = await res.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content || !content.trim()) throw new Error("empty completion");
  return content.trim();
}

/* ----------------------------- STEP 3: guardrails (CODE) ----------------------------- */
function enforce(text) {
  if (!text) return { ok: false, reason: "empty draft" };
  const t = String(text).trim().replace(/^```[a-z]*\s*|\s*```$/gi, "").trim().replace(/^"+|"+$/g, "").trim();
  const lines = [];
  for (const raw of t.replace(/\r\n/g, "\n").split("\n")) {
    const l = raw.trim().replace(/^(?:line\s*\d\s*[:.\-]\s*|\d+[.)]\s+|[-*]\s+)/i, "").trim();
    if (!l) continue;
    if (/^(hi|hey|hello|dear)\b/i.test(l) || /^subject\s*:/i.test(l)) continue;
    if (/^(best|cheers|thanks|regards|sincerely|warmly)\b/i.test(l) && wc(l) <= 4) continue;
    lines.push(l);
  }
  if (lines.length > 3) lines.length = 3;
  if (lines.length !== 3) return { ok: false, reason: "expected 3 lines, got " + lines.length };
  const joined = lines.join("\n");
  const n = wc(joined);
  if (n > WORD_LIMIT) return { ok: false, reason: n + " words exceeds " + WORD_LIMIT };
  const b = hasBanned(joined);
  if (b) return { ok: false, reason: 'banned phrase "' + b + '"' };
  if (!lines[2].includes("?")) return { ok: false, reason: "line 3 has no question" };
  return { ok: true, text: joined, words: n };
}

/* ----------------------------- STEP 4: heuristic fallback (CODE, zero-key) ----------------------------- */
function heuristicOpener(sig) {
  const company = sig.company || "Your team";
  const seed = [...sig.domain].reduce((a, c) => a + c.charCodeAt(0), 0);
  const h1 = sig.h1 ? capWords(sig.h1.replace(/\.+$/, ""), 8) : "";
  const desc = sig.description ? capWords(sig.description.replace(/\.+$/, ""), 12) : "";
  const free = FREE_DISPLAY[sig.free_tier] || sig.free_tier;
  const prices = sig.prices;
  const c = [];
  if (prices.length && free) c.push("Your site pairs a " + free + " with paid plans from " + prices[0] + ".");
  if (prices.length) c.push(company + " publishes pricing from " + prices[0] + " right on the site.");
  if (sig.open_source) c.push(company + " ships in the open - the repo and " + (free ? "free-tier" : "self-serve") + " positioning are front and center.");
  else if (free) c.push(company + " leads with a " + free + " before asking for a card.");
  if (h1) c.push("Your homepage leads with \u201C" + h1 + ".\u201D");
  if (desc) c.push("Your site pitches " + company + " as \u201C" + desc + ".\u201D");
  const l1 = c.find((x) => !hasBanned(x) && wc(x) <= 18);
  if (!l1) return null;
  const pains = {
    scheduling: "Teams at $10-50K MRR usually lose signups between connecting a calendar and the first booked meeting.",
    analytics: "At $10-50K MRR, the pinch is getting teams past first setup to a habit of weekly dashboards.",
    links: "At $10-50K MRR, click volume rarely converts to paid seats without a tight signup-to-activation loop.",
    devtool: "For a $10-50K MRR dev tool, the usual bottleneck is time from signup to first successful API call.",
  };
  const l2 = pains[sig.category] || (free
    ? "Free-to-paid conversion is usually the first real bottleneck a $10-50K MRR team hits."
    : "At $10-50K MRR, the usual pinch is turning early traction into repeatable activation and expansion.");
  const hooks = {
    scheduling: "Where do new users stall first - calendar connect or sharing the link?",
    analytics: "Which is leaking more - first setup or week-four retention?",
    links: "Are paid upgrades driven more by teams or by click volume?",
    devtool: "How long until a new signup makes their first successful call?",
  };
  let l3 = free ? "What share of free accounts touches a paid feature in week one?"
    : prices.length ? "Is the bigger leak right now trial-to-paid or seat expansion?"
    : (hooks[sig.category] || "Which is leaking more today - activation or trial-to-paid?");
  const variants = [l3];
  if (hooks[sig.category] && hooks[sig.category] !== l3) variants.push(hooks[sig.category]);
  l3 = variants[seed % variants.length];
  return [l1, l2, l3].join("\n");
}

/* ----------------------------- handler ----------------------------- */
module.exports = async function handler(req, res) {
  const t0 = Date.now();
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only.", step: "validate", latencyMs: Date.now() - t0 });
  }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const url = normalizeUrl((body || {}).url);

    const s0 = Date.now();
    const page = await scrape(url);
    const scrapeMs = Date.now() - s0;
    const scrapedChars = page.content.length;
    const context = page.content.slice(0, CONTEXT_LIMIT);   // the only text the model ever sees
    const signals = extractSignals(page, url);

    const cfg = resolveLLM();
    let opener = null, mode = "heuristic", note = "";
    if (cfg.key) {
      try {
        const v = enforce(await llmDraft(context, signals, url, cfg));
        if (v.ok) { opener = v.text; mode = "llm"; }
        else note = "LLM draft rejected by guardrails (" + v.reason + ") - deterministic fallback.";
      } catch (e) {
        note = "LLM step failed (" + (e.message || "error") + ") - deterministic fallback.";
      }
    } else {
      note = "No LLM_API_KEY on the server - heuristic drafted from the same live-scraped signals.";
    }
    if (!opener) {
      const h = heuristicOpener(signals);
      const v = h ? enforce(h) : { ok: false, reason: "no grounded signals" };
      if (!v.ok) throw httpError(422, "Could not ground an opener: the scrape had no usable H1, description, or pricing signals. Nothing was invented.", "draft");
      opener = v.text;
      mode = cfg.key ? "heuristic-fallback" : "heuristic";
    }

    return res.status(200).json({
      opener, scrapedPreview: context, latencyMs: Date.now() - t0,
      mode, model: mode === "llm" ? cfg.model : null, words: wc(opener),
      scrapeMs, scrapedChars, signals, note,
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      error: e.message || "Unexpected error.", step: e.step || "draft", latencyMs: Date.now() - t0,
    });
  }
}
