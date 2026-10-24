// ماهر النحو — سوال جواب AI proxy (Vercel serverless function)
// Deployed ONCE into the repo as api/answer.js. Holds the Gemini API key
// server-side (Vercel env var GEMINI_API_KEY) so the key never appears in
// the page. Verifies the caller's Firebase ID token and that the caller is
// an ACTIVE user in the Firestore allowlist before spending any quota.
//
// Env vars required in Vercel project settings:
//   GEMINI_API_KEY   — the AI Studio key (secret)
//   FIREBASE_API_KEY — the site's public Firebase web apiKey (already public)

const GEMINI_MODEL = "gemini-2.5-flash";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyBSIsS5uk6wEu3nd7rimi8Pwu3Naw_nL2Q";

const SYSTEM_NAHW = `You are the answer engine inside «ماہر النحو», a website devoted EXCLUSIVELY to Arabic grammar (فن النحو). Rules:
1. Answer ONLY questions of Nahw (Arabic grammar). If a question is outside Nahw, politely guide the student to the nearest Nahw topic instead of answering the foreign topic.
2. Give a COMPLETE, authenticated answer at once: the rule/analysis, clear explanation, and worked examples. For any Arabic text, verse (ayah) or hadith whose tarkeeb/i'rab is requested, give the full tarkeeb: first a concise sentence-level (مجمل) analysis, then word-by-word (مفصل): each word's kind, its i'rab or bina', its grammatical function, and for every مبنی word whether it is مبنی اصل or مبنی غیر اصل with the reason.
3. Where more than one i'rab is classically valid, present ALL valid ihtimalat; never force a single one.
4. Quote Quranic text only from the verse text supplied in the request or from the exact question; never invent verses, hadith, or book references. Examples from classical Nahw books must be famous, standard ones.
5. Reply in the language named in the request (Urdu / Sindhi / Arabic), keeping Arabic grammatical terms in Arabic script. Structure the answer with short headings and line breaks so it can be read aloud sentence by sentence.`;

async function verifyCaller(idToken) {
  const r = await fetch(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const email = data.users && data.users[0] && data.users[0].email;
  if (!email) return null;
  if (email.toLowerCase() === "ashrafahmadani953@gmail.com") return email;
  const projectId = "mahirunnahw";
  const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(email.toLowerCase())}`;
  const d = await fetch(docUrl, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!d.ok) return null;
  const doc = await d.json();
  const active = doc.fields && doc.fields.active && doc.fields.active.booleanValue === true;
  return active ? email : null;
}

async function geminiAnswer(question, langName, contextText, kind) {
  const key = process.env.GEMINI_API_KEY;
  let userText = `Reply language: ${langName}.\nStudent question: ${question}` +
    (contextText ? `\nRelevant text from the app's own library (Quran/hadith wording supplied verbatim):\n${contextText}` : "");
  if (kind === "tarkeeb") {
    userText += `\n\nOUTPUT FORMAT (mandatory): reply with ONLY a JSON object, no markdown fences, no extra text:
{"passage": "<the complete Arabic passage/ayah exactly as supplied>", "translation": "<a faithful translation of the passage into ${langName}>", "mujmal": "<concise sentence-level tarkeeb (مجمل) in ${langName}, Arabic terms in Arabic script>", "mufassal": "<full word-by-word tarkeeb (مفصل): every word — its kind, i'rab or bina', its function; for every مبنی word state مبنی اصل or مبنی غیر اصل with the reason; list all valid ihtimalat where they exist — in ${langName}, Arabic terms in Arabic script>"}`;
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_NAHW }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    }),
  });
  if (!r.ok) throw new Error("gemini_" + r.status);
  const data = await r.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const raw = parts.map(p => p.text || "").join("").trim();
  if (kind === "tarkeeb") {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const obj = JSON.parse(cleaned);
      if (obj && obj.passage && obj.mujmal && obj.mufassal) return obj;
    } catch (e) { }
    return { answer: raw };
  }
  return { answer: raw };
}

function pcmToWavBase64(pcmBase64, sampleRate = 24000) {
  const pcm = Buffer.from(pcmBase64, "base64");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

async function geminiSpeak(text, voiceName) {
  const key = process.env.GEMINI_API_KEY;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || "Kore" } } },
      },
    }),
  });
  if (!r.ok) throw new Error("tts_" + r.status);
  const data = await r.json();
  const inline = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline || !inline.data) throw new Error("tts_empty");
  return pcmToWavBase64(inline.data);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method" }); return; }
  try {
    const { mode, question, lang, langName, contextText, text, voice, idToken, kind } =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!idToken) { res.status(401).json({ error: "no_token" }); return; }
    const email = await verifyCaller(idToken);
    if (!email) { res.status(403).json({ error: "not_allowed" }); return; }
    if (mode === "speak") {
      if (!text) { res.status(400).json({ error: "no_text" }); return; }
      const audio = await geminiSpeak(String(text).slice(0, 1200), voice);
      res.status(200).json({ audioWavBase64: audio });
      return;
    }
    if (!question) { res.status(400).json({ error: "no_question" }); return; }
    const out = await geminiAnswer(String(question).slice(0, 1000), langName || "Urdu", contextText || "", kind || "");
    res.status(200).json({ ...out, lang: lang || "ur" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
