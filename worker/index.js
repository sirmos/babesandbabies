export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    try {
      const { systemPrompt, history, userMsg } = await request.json();

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt + '\n' + userMsg }] }]
          })
        }
      );

      const data = await response.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) return new Response(JSON.stringify({ reply }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });

      return new Response(JSON.stringify({ reply: 'Error: ' + JSON.stringify(data) }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });

    } catch(e) {
      return new Response(JSON.stringify({ reply: 'Exception: ' + e.message }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
