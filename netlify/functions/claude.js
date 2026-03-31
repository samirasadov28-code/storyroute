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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "GROQ_API_KEY not set" }), {
      status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  let body;
  try { body = await req.json(); }
  catch(e) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "Invalid JSON" }), {
      status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  // Retry up to 3 times with backoff on rate limit
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",  // fastest Groq model
          max_tokens: 1024,
          temperature: 0.7,
          messages: body.messages
        })
      });

      // Rate limited — wait and retry
      if (response.status === 429) {
        const wait = (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        return new Response(JSON.stringify({ content: [{ text: "" }], error: `Groq ${response.status}: ${errText}` }), {
          status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return new Response(JSON.stringify({ content: [{ text }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch(e) {
      if (attempt === 2) {
        return new Response(JSON.stringify({ content: [{ text: "" }], error: e.message }), {
          status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
};

export const config = { path: "/api/claude" };
