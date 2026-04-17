// Edge function backing /api/claude — proxies to Groq.
// Hardening (2026-04):
//  - Allowlisted CORS + Origin/Referer check (blocks browser abuse from other sites)
//  - Per-IP sliding-window rate limit + daily cap (blocks scripted abuse)
//  - Hard cap on incoming prompt size (limits token burn per abusive call)

const ALLOWED_ORIGIN_SUFFIXES = [
  "storyroute.app",
  "storyroute.netlify.app",
  "localhost",
  "127.0.0.1"
];

// Per-isolate in-memory counters. Netlify Edge may run multiple isolates, so
// this is a best-effort throttle, not a hard guarantee — but combined with the
// origin check it shuts down the trivial "curl in a loop" abuse path.
const RATE_WINDOW_MS = 60_000;
const RATE_WINDOW_MAX = 6;      // max 6 requests / IP / minute
const RATE_DAY_MAX = 120;       // max 120 requests / IP / 24h
const MAX_PROMPT_CHARS = 4000;  // ~1k tokens of user input

const recentHits = new Map();   // ip -> number[] (timestamps, last minute)
const dailyHits = new Map();    // ip -> { day: string, count: number }

function isAllowedOrigin(originHeader) {
  if (!originHeader) return false;
  let host;
  try { host = new URL(originHeader).hostname; } catch { return false; }
  return ALLOWED_ORIGIN_SUFFIXES.some(
    suffix => host === suffix || host.endsWith("." + suffix)
  );
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonError(status, message, origin) {
  return new Response(
    JSON.stringify({ content: [{ text: "" }], error: message }),
    {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
    }
  );
}

function rateLimited(ip) {
  const now = Date.now();

  const arr = (recentHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_WINDOW_MAX) {
    recentHits.set(ip, arr);
    return "minute";
  }
  arr.push(now);
  recentHits.set(ip, arr);

  const today = new Date(now).toISOString().slice(0, 10);
  const dayRec = dailyHits.get(ip);
  if (!dayRec || dayRec.day !== today) {
    dailyHits.set(ip, { day: today, count: 1 });
  } else {
    dayRec.count += 1;
    if (dayRec.count > RATE_DAY_MAX) return "day";
  }

  // Opportunistic cleanup so the maps don't grow unbounded.
  if (recentHits.size > 5000) {
    for (const [k, v] of recentHits) {
      if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) recentHits.delete(k);
    }
  }
  if (dailyHits.size > 5000) {
    for (const [k, v] of dailyHits) {
      if (v.day !== today) dailyHits.delete(k);
    }
  }

  return null;
}

export default async (req, context) => {
  const origin = req.headers.get("origin") || "";
  const referer = req.headers.get("referer") || "";
  const originOk = isAllowedOrigin(origin) || isAllowedOrigin(referer);
  const corsOrigin = originOk ? origin : "null";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: originOk ? 204 : 403,
      headers: corsHeaders(corsOrigin)
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!originOk) {
    return jsonError(403, "Forbidden origin", corsOrigin);
  }

  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    context?.ip ||
    "unknown";

  const limited = rateLimited(ip);
  if (limited) {
    return jsonError(
      429,
      limited === "day" ? "Daily limit reached" : "Too many requests",
      corsOrigin
    );
  }

  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return jsonError(500, "GROQ_API_KEY not set", corsOrigin);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON", corsOrigin);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "Missing or empty messages array", corsOrigin);
  }

  const totalChars = body.messages.reduce(
    (n, m) => n + (typeof m?.content === "string" ? m.content.length : 0),
    0
  );
  if (totalChars > MAX_PROMPT_CHARS) {
    return jsonError(413, "Prompt too large", corsOrigin);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      let response;
      try {
        response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            max_tokens: 1024,
            temperature: 0.9,
            system: "You are a masterful audio tour storyteller. You write rich, vivid, specific spoken-word stories for people walking past historic landmarks. Your stories are gripping, full of real names, dates, and surprising details. You never use filler phrases. You always write at least 180 words. You always complete your story — never cut it short.",
            messages: body.messages
          })
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 429) {
        const wait = (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        return jsonError(502, `Groq ${response.status}: ${errText}`, corsOrigin);
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return new Response(JSON.stringify({ content: [{ text }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(corsOrigin) }
      });

    } catch (e) {
      const isTimeout = e.name === "AbortError";
      if (attempt === 2) {
        return jsonError(
          504,
          isTimeout ? "Request timed out after 20s" : e.message,
          corsOrigin
        );
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return jsonError(429, "Rate limited after 3 attempts", corsOrigin);
};

export const config = { path: "/api/claude" };
