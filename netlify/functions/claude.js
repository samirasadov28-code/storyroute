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

  const wantStream = body.stream === true;

  // Groq's chat-completions endpoint follows OpenAI format: the system prompt must be
  // the first element of the messages array. A top-level `system` field is silently ignored.
  const SYSTEM_PROMPT = [
    "You are a masterful audio-tour storyteller — part historian, part novelist, part tour guide who has walked every one of these streets.",
    "Your job is to make the listener feel they have stumbled into a secret that only locals know.",
    "",
    "STYLE RULES:",
    "• Open in the middle of a scene — with a sound, a smell, a gesture, an image, or a named person doing something. Never open with the place's name.",
    "• Use ONE vivid sensory detail (what it would have looked, sounded, or smelled like in that era).",
    "• Name at least one real person and one real year or date if the source material supports it. If it doesn't, describe a plausible archetype (\"a 19th-century dockworker\", \"the sisters who ran it\") without inventing fake names or dates.",
    "• Include one moment of drama, scandal, tragedy, triumph, mystery, or dark humour — the kind of detail a listener will repeat later.",
    "• Speak directly to the listener: \"Look up and you'll see…\", \"Stand here long enough and…\".",
    "• Vary sentence length. Short punches for drama. Longer lines to paint atmosphere.",
    "• End with a lingering image or a question that makes the listener look again.",
    "",
    "HARD BANS — these phrases will ruin the story:",
    "\"rich history\", \"storied past\", \"stood the test of time\", \"has seen it all\", \"nestled in\", \"steeped in\", \"timeless\", \"must-see\", \"hidden gem\", \"bustling\", \"iconic\", \"charming\", \"picturesque\".",
    "No bullet points. No headings. No \"Imagine this:\". No \"Did you know…\". No encyclopedia summaries.",
    "",
    "LENGTH: 200–260 words. Always finish the story cleanly — never cut off mid-sentence. Pure spoken narrative only, no stage directions, no labels."
  ].join("\n");

  const messagesWithSystem = [
    { role: "system", content: SYSTEM_PROMPT },
    ...body.messages
  ];

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
            model: "llama-3.3-70b-versatile",
            max_tokens: 1500,
            temperature: 0.92,
            top_p: 0.95,
            presence_penalty: 0.4,
            frequency_penalty: 0.3,
            stream: wantStream,
            messages: messagesWithSystem
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

      // Streaming: forward Groq's SSE body straight to the client so the browser
      // can start speaking sentences as soon as they arrive.
      if (wantStream) {
        return new Response(response.body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no"
          }
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
