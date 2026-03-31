export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // FIX 1: Use Deno.env.get() — this is an Edge Function (Deno runtime), process.env is undefined
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "GROQ_API_KEY not set" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "Invalid JSON" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  // FIX 2: Validate messages before sending to Groq
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "Missing or empty messages array" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  // Retry up to 3 times with backoff on rate limit
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // FIX 3: Add a 20s fetch timeout via AbortController to avoid opaque Netlify platform timeouts
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
            // Upgraded from llama-3.1-8b-instant for richer story output
            model: "llama-3.3-70b-versatile",
            // Bumped from 1024 to avoid JSON truncation on longer stories
            max_tokens: 2048,
            temperature: 0.7,
            messages: body.messages
          })
        });
      } finally {
        clearTimeout(timeout);
      }

      // Rate limited — wait and retry
      if (response.status === 429) {
        const wait = (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        return new Response(JSON.stringify({ content: [{ text: "" }], error: `Groq ${response.status}: ${errText}` }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return new Response(JSON.stringify({ content: [{ text }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (e) {
      // AbortError = fetch timeout
      const isTimeout = e.name === "AbortError";
      if (attempt === 2) {
        return new Response(JSON.stringify({
          content: [{ text: "" }],
          error: isTimeout ? "Request timed out after 20s" : e.message
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // FIX 4: Explicit fallback return — prevents undefined response if all 3 attempts hit 429
  return new Response(JSON.stringify({ content: [{ text: "" }], error: "Rate limited after 3 attempts" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
};

export const config = { path: "/api/claude" };
