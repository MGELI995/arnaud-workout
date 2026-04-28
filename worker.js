const GITHUB_OWNER  = 'MGELI995';
const GITHUB_REPO   = 'second-brain-vault';
const GITHUB_BRANCH = 'main';
const DAILY_PATH    = (date) => `CONTROL/DAILY/${date}.md`;
const SECTION_ORDER = ['HABITS', 'TIME_FOCUS', 'SPORT'];

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ─── ROUTE GET /?date= → retourne la section HABITS du fichier GitHub ────
    if (request.method === 'GET') {
      const params  = new URL(request.url).searchParams;
      const date    = params.get('date');
      const section = params.get('section') || 'HABITS';
      if (!date) return new Response(JSON.stringify({ error: 'date required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
      try {
        const file = await ghGet(env.GITHUB_TOKEN, DAILY_PATH(date));
        if (!file) return new Response(JSON.stringify({ text: null }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        const START   = `<!-- ${section}_START -->`;
        const END     = `<!-- ${section}_END -->`;
        const si      = file.text.indexOf(START);
        const ei      = file.text.indexOf(END);
        const text    = (si !== -1 && ei !== -1) ? file.text.slice(si + START.length, ei).trim() : null;
        return new Response(JSON.stringify({ text }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch(err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

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
      const { content, date, section, filename } = body;

      if (!date || !section || !content) return new Response(
        JSON.stringify({ error: 'date, section et content sont requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

      await upsertSection(env.GITHUB_TOKEN, DAILY_PATH(date), date, section, content);

      // Si un fichier cible différent du DAILY est spécifié, y appender aussi
      if (filename && filename !== DAILY_PATH(date)) {
        await appendToFile(env.GITHUB_TOKEN, filename, content);
      }

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

async function ghPutWithRetry(token, path, getText, commitMsg, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const file = await ghGet(token, path);
    const text = getText(file?.text || '');
    try {
      await ghPut(token, path, text, file?.sha, commitMsg);
      return;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
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
  const block = `${start}\n${sectionContent.trim()}\n${end}`;
  const msg   = section === 'HABITS' ? `habits: ${date}` : section === 'SPORT' ? `sport: ${date}` : `daily: ${date}`;

  await ghPutWithRetry(token, path, (existing) => {
    if (!existing) return `# DAILY — ${date}\n\n${block}\n`;
    if (existing.includes(start))
      return existing.replace(new RegExp(escRe(start) + '[\\s\\S]*?' + escRe(end)), block);
    return insertInOrder(existing, block, section);
  }, msg);
}


/* ── Append to arbitrary file (e.g. OUTDOOR_LOG.md) ────────────────────── */

async function appendToFile(token, path, content) {
  const existing = await ghGet(token, path);
  const newText  = existing ? (existing.text.trimEnd() + '\n' + content) : content;
  await ghPut(token, path, newText, existing?.sha, `outdoor: append`);
}
