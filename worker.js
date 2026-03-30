const GITHUB_OWNER  = 'MGELI995';
const GITHUB_REPO   = 'second-brain-vault';
const GITHUB_BRANCH = 'main';
const DAILY_PATH    = (date) => `CONTROL/DAILY/${date}.md`;
const SECTION_ORDER = ['HABITS', 'TIME_FOCUS', 'SPORT'];

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405, headers: corsHeaders });

    const url = new URL(request.url);

    // ─── ROUTE /analyze → Proxy Gemini ──────────────────────────────────────
    if (url.pathname === '/analyze') {
      try {
        const body = await request.json();
        const { parts, comments } = body;

        if (!parts) return new Response(JSON.stringify({ error: 'Missing parts' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

        const prompt = `You are a nutrition expert. Analyze this food photo.
User comments (treat as absolute truth): "${comments || 'none'}"
NEVER underestimate fats in restaurant meals.
Reply with ONLY this JSON, no other text, no markdown:
{"label":"dish name","calories":650,"protein":35,"fat":28,"carbs":60}`;

        const allParts = [...parts, { text: prompt }];

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: allParts }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
            })
          }
        );

        const data = await geminiRes.json();
        if (!geminiRes.ok) throw new Error(data.error?.message || `Gemini error ${geminiRes.status}`);

        const raw      = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const calories = (raw.match(/"calories":(\d+)/) || [])[1];
        const protein  = (raw.match(/"protein":(\d+)/)  || [])[1];
        const fat      = (raw.match(/"fat":(\d+)/)      || [])[1];
        const carbs    = (raw.match(/"carbs":(\d+)/)    || [])[1];
        const labelM   = raw.match(/"label":"([^"]+)"/);

        return new Response(JSON.stringify({
          label:    labelM ? labelM[1] : 'Repas',
          calories: calories ? parseInt(calories) : 0,
          protein:  protein  ? parseInt(protein)  : 0,
          fat:      fat      ? parseInt(fat)      : 0,
          carbs:    carbs    ? parseInt(carbs)    : 0,
          analysis: ''
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ─── ROUTE / → GitHub centralisé ────────────────────────────────────────
    try {
      const body = await request.json();
      const { content, date, section } = body;

      if (!date || !section || !content) return new Response(
        JSON.stringify({ error: 'date, section et content sont requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

      await upsertSection(env.GITHUB_TOKEN, DAILY_PATH(date), date, section, content);

      return new Response(JSON.stringify({ success: true, file: DAILY_PATH(date) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

/* ── GitHub helpers ─────────────────────────────────────────────────────── */

async function ghGet(token, path) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`,
    { headers: { 'Authorization': `token ${token}`, 'User-Agent': 'obsidian-worker', 'Accept': 'application/vnd.github.v3+json' } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data  = await res.json();
  const bytes = atob(data.content.replace(/\n/g, ''));
  const arr   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return { text: new TextDecoder().decode(arr), sha: data.sha };
}

async function ghPut(token, path, text, sha, commitMsg) {
  const encoder = new TextEncoder();
  const bytes   = encoder.encode(text);
  let binary    = '';
  bytes.forEach(b => binary += String.fromCharCode(b));

  const body = { message: commitMsg || `daily: ${path.split('/').pop()}`, content: btoa(binary), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'obsidian-worker', 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) { const e = await res.text(); throw new Error(`GitHub PUT ${res.status}: ${e}`); }
}

/* ── Section upsert ─────────────────────────────────────────────────────── */

function markers(section) {
  return { start: `<!-- ${section}_START -->`, end: `<!-- ${section}_END -->` };
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function insertInOrder(text, block, section) {
  const idx = SECTION_ORDER.indexOf(section);
  for (let i = idx + 1; i < SECTION_ORDER.length; i++) {
    const pos = text.indexOf(markers(SECTION_ORDER[i]).start);
    if (pos !== -1) return text.slice(0, pos) + block + '\n\n' + text.slice(pos);
  }
  return text.trimEnd() + '\n\n' + block + '\n';
}

async function upsertSection(token, path, date, section, sectionContent) {
  const { start, end } = markers(section);

  // TIME_FOCUS : additive (cumul des minutes de la journée)
  let finalContent = sectionContent;
  if (section === 'TIME_FOCUS') {
    const file = await ghGet(token, path);
    if (file && file.text.includes(start)) {
      const existing = extractSection(file.text, start, end);
      const merged   = mergeTimes(existing, sectionContent);
      finalContent   = buildTimeFocusContent(date, merged);
      const block    = `${start}\n${finalContent.trim()}\n${end}`;
      const newText  = file.text.replace(new RegExp(escRe(start) + '[\\s\\S]*?' + escRe(end)), block);
      await ghPut(token, path, newText, file.sha, `time: ${date}`);
      return;
    }
  }

  const file  = await ghGet(token, path);
  const block = `${start}\n${finalContent.trim()}\n${end}`;

  let newText;
  if (!file) {
    newText = `# DAILY — ${date}\n\n${block}\n`;
  } else if (file.text.includes(start)) {
    newText = file.text.replace(new RegExp(escRe(start) + '[\\s\\S]*?' + escRe(end)), block);
  } else {
    newText = insertInOrder(file.text, block, section);
  }

  const msg = section === 'HABITS' ? `habits: ${date}` : section === 'SPORT' ? `sport: ${date}` : `daily: ${date}`;
  await ghPut(token, path, newText, file?.sha, msg);
}

/* ── Time Focus helpers ─────────────────────────────────────────────────── */

function extractSection(text, start, end) {
  const re    = new RegExp(escRe(start) + '([\\s\\S]*?)' + escRe(end));
  const match = text.match(re);
  return match ? match[1].trim() : '';
}

function parseTimeFocus(text) {
  const result = {};
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^([^:]+)::\s*(\d+)/);
    if (m) { const mins = parseInt(m[2]); if (mins > 0) result[m[1].trim()] = mins; }
  }
  return result;
}

function mergeTimes(existingText, incomingText) {
  const existing = parseTimeFocus(existingText);
  const incoming = parseTimeFocus(incomingText);
  const merged   = { ...existing };
  for (const [cat, mins] of Object.entries(incoming)) merged[cat] = (merged[cat] || 0) + mins;
  return merged;
}

const CATS = ['CORAN','ARABIC','BJJ','PODCAST','DEV','MASJID','ISLAMIC FINANCE','BOOK','FINANCE','ISLAM','ANGLAIS','GYM'];

function buildTimeFocusContent(date, times) {
  const total   = Object.values(times).reduce((a, b) => a + b, 0);
  const fmtMins = m => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? m % 60 + 'm' : ''}`;
  let c  = `## TIME FOCUS — ${date}\n\n`;
  c     += `**Total : ${fmtMins(total)}**\n\n`;
  for (const cat of CATS) c += `${cat}:: ${times[cat] || 0}\n`;
  return c;
}
