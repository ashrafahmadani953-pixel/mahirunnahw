// ماهر النحو — سوال جواب AI proxy (Vercel serverless function)
// Deployed into the repo as api/answer.js. Holds the Gemini API key
// server-side (Vercel env var GEMINI_API_KEY) so the key never appears in
// the page. Verifies the caller's Firebase ID token and that the caller is
// an ACTIVE user in the Firestore allowlist before spending any quota.
//
// SELF-HEALING MODELS (2026-10-24): no model name is trusted for long —
// Google retires model ids and closes them to new keys (gemini-2.5-flash
// began returning 404 for this key, and per-model free quotas run out
// with 429). So the proxy ASKS GOOGLE which models this key may use
// (ListModels), ranks them, caches the list for 30 minutes, and walks it
// per request: 404 / 429 / 5xx all move on to the next model. If the
// ListModels call itself fails, the hardcoded fallback lists below apply.
//
// Env vars required in Vercel project settings:
//   GEMINI_API_KEY   — the AI Studio key (secret)
//   FIREBASE_API_KEY — the site's public Firebase web apiKey (already public)

const FALLBACK_ANSWER_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash"];
const FALLBACK_TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyBSIsS5uk6wEu3nd7rimi8Pwu3Naw_nL2Q";

const SYSTEM_NAHW = `You are the answer engine inside «ماہر النحو», a website devoted EXCLUSIVELY to Arabic grammar (فن النحو). Rules:
1. Answer ONLY questions of Nahw (Arabic grammar). If a question is outside Nahw, politely guide the student to the nearest Nahw topic instead of answering the foreign topic.
2. Give a COMPLETE, authenticated answer at once: the rule/analysis, clear explanation, and worked examples. For any Arabic text, verse (ayah) or hadith whose tarkeeb/i'rab is requested, give the full tarkeeb: first a concise sentence-level (مجمل) analysis, then word-by-word (مفصل): each word's kind, its i'rab or bina', its grammatical function, and for every مبنی word whether it is مبنی اصل or مبنی غیر اصل with the reason.
3. Where more than one i'rab is classically valid, present ALL valid ihtimalat; never force a single one.
4. Quote Quranic text only from the verse text supplied in the request or from the exact question; never invent verses, hadith, or book references. Examples from classical Nahw books must be famous, standard ones.
5. Reply in the language named in the request (Urdu / Sindhi / Arabic), keeping Arabic grammatical terms in Arabic script. Structure the answer with short headings and line breaks so it can be read aloud sentence by sentence.`;

async function verifyCaller(idToken) {
  // Verify Firebase ID token -> email, via Identity Toolkit (no SDK needed).
  const r = await fetch(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const email = data.users && data.users[0] && data.users[0].email;
  if (!email) return null;
  // Admin first: the admin has no users/{email} doc by design, so this check
  // must precede the Firestore doc read or the admin locks himself out.
  if (email.toLowerCase() === "ashrafahmadani953@gmail.com") return email;
  // Allowlist + active check: read users/{email} in Firestore with the same token.
  const projectId = "mahirunnahw";
  const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(email.toLowerCase())}`;
  const d = await fetch(docUrl, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!d.ok) return null;
  const doc = await d.json();
  const active = doc.fields && doc.fields.active && doc.fields.active.booleanValue === true;
  return active ? email : null;
}

// ---- Self-healing model discovery ----------------------------------------
// Rank a text model: newest Gemini version first; Flash before Pro (speed
// and free quota); full Flash before Flash-Lite (quality); stable before
// preview. Gemma counts only as a last resort.
function textModelScore(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
  let s = (m ? parseFloat(m[1]) : 0) * 1000;
  if (name.includes("flash")) s += 100;
  else if (name.includes("pro")) s += 50;
  if (name.includes("lite")) s -= 10;
  if (name.includes("preview")) s -= 20;
  if (name.startsWith("gemma")) s -= 5000;
  return s;
}

let modelCache = { at: 0, text: null, tts: null };

async function discoverModels() {
  const now = Date.now();
  if (modelCache.text && now - modelCache.at < 30 * 60 * 1000) return modelCache;
  const key = process.env.GEMINI_API_KEY;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    if (!r.ok) throw new Error("list_" + r.status);
    const data = await r.json();
    const usable = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
    const text = usable
      .filter(n => !n.includes("tts") && !n.includes("image") && !n.includes("audio") &&
                   !n.includes("live") && !n.includes("embedding") && !n.includes("robotics") &&
                   !n.includes("computer-use") && !n.includes("aqa"))
      .sort((a, b) => textModelScore(b) - textModelScore(a));
    const tts = usable
      .filter(n => n.includes("tts"))
      .sort((a, b) => textModelScore(b) - textModelScore(a));
    if (text.length) modelCache = { at: now, text, tts: tts.length ? tts : FALLBACK_TTS_MODELS };
  } catch (e) { /* keep whatever we have; fallbacks apply below */ }
  if (!modelCache.text) modelCache = { at: now, text: FALLBACK_ANSWER_MODELS, tts: FALLBACK_TTS_MODELS };
  return modelCache;
}

// POST generateContent walking the model list: 404 (model closed to this
// key), 429 (this model's free quota used up) and 5xx (transient trouble)
// all move on to the next model. Any other HTTP error aborts with its code.
async function geminiCall(models, body) {
  const key = process.env.GEMINI_API_KEY;
  let lastErr = null;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return { model, data: await r.json() };
    if (r.status === 404 || r.status === 429 || r.status >= 500) { lastErr = new Error("gemini_" + r.status); continue; }
    throw new Error("gemini_" + r.status);
  }
  throw lastErr || new Error("gemini_404");
}

async function geminiAnswer(question, langName, contextText, kind) {
  let userText = `Reply language: ${langName}.\nStudent question: ${question}` +
    (contextText ? `\nRelevant text from the app's own library (Quran/hadith wording supplied verbatim):\n${contextText}` : "");
  if (kind === "tarkeeb") {
    userText += `\n\nOUTPUT FORMAT (mandatory): reply with ONLY a JSON object, no markdown fences, no extra text:
{"passage": "<the complete Arabic passage/ayah exactly as supplied>", "translation": "<a faithful translation of the passage into ${langName}>", "mujmal": "<concise sentence-level tarkeeb (مجمل) in ${langName}, Arabic terms in Arabic script>", "mufassal": "<full word-by-word tarkeeb (مفصل): every word — its kind, i'rab or bina', its function; for every مبنی word state مبنی اصل or مبنی غیر اصل with the reason; list all valid ihtimalat where they exist — in ${langName}, Arabic terms in Arabic script>"}`;
  }
  const models = (await discoverModels()).text;
  const { data } = await geminiCall(models, {
    systemInstruction: { parts: [{ text: SYSTEM_NAHW }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  const raw = parts.map(p => p.text || "").join("").trim();
  if (kind === "tarkeeb") {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const obj = JSON.parse(cleaned);
      if (obj && obj.passage && obj.mujmal && obj.mufassal) return obj;
    } catch (e) { /* fall through to plain answer */ }
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
  const models = (await discoverModels()).tts;
  const { data } = await geminiCall(models, {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || "Kore" } } },
    },
  });
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
