const functions = require("firebase-functions");
const fetch = require("node-fetch");

exports.chat = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  const { message } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `You are a helpful AI assistant for Babes & Babies, a beauty and baby products shop in Port Harcourt, Nigeria. 
            Help customers with hair styling recommendations, baby product advice, and booking appointments.
            Be warm, friendly and knowledgeable. Keep responses concise.
            
            Customer message: ${message}`
          }]
        }]
      })
    }
  );

  const data = await response.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't process that.";
  res.json({ reply });
});
