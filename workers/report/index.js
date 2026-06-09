/**
 * Found Everywhere - AI Visibility Report Worker
 *
 * Routes:
 *   POST /api/generate-report  → runs the multi-model visibility analysis,
 *                                stores the report in KV, emails the user.
 *   GET  /api/report/:id       → returns a stored report as JSON (used by
 *                                the SSR report page).
 *
 * Bindings (wrangler.toml):
 *   REPORTS          KV - stores generated reports (key report:{uuid})
 *   REPORT_REQUESTS  KV - rate-limit ledger (key email:{email})
 *
 * Secrets (Cloudflare dashboard, never in code):
 *   ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, OPENAI_API_KEY,
 *   RESEND_API_KEY, TURNSTILE_SECRET_KEY, SERPAPI_KEY
 *
 * Vars:
 *   ALLOWED_ORIGIN - e.g. https://foundeverywhere.co.uk
 */

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const PERPLEXITY_MODEL = 'sonar';
const OPENAI_MODEL = 'gpt-4.1';
// Model used for the OpenAI Responses API (live web search) brand check.
const OPENAI_SEARCH_MODEL = 'gpt-4.1';

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://foundeverywhere.co.uk',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Pull the first [...] JSON array out of a model's text response. */
function extractJsonArray(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Pull the first {...} JSON object out of a model's text response. */
function extractJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Normalise US English spellings to UK English equivalents. */
function toUkEnglish(text) {
  if (text == null) return text;
  return String(text)
    .replace(/optimization/gi, 'optimisation')
    .replace(/organize/gi, 'organise')
    .replace(/analyze/gi, 'analyse')
    .replace(/color/gi, 'colour')
    .replace(/center/gi, 'centre');
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Strip markdown/citation noise out of AI prose before it is stored, so
 * the report renders clean text rather than raw **bold**, ## headings,
 * [1][2] citation markers, etc.
 */
function stripMarkdown(text) {
  if (!text) return '';
  return String(text)
    // bold / italic markers (**x**, __x__, *x*, _x_)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // bracketed citation markers like [1] [2][3]
    .replace(/\[\d+\]/g, '')
    // markdown headings (## , ### at line starts or inline)
    .replace(/#{1,6}\s*/g, '')
    // stray leftover heading hashes
    .replace(/`+/g, '')
    // collapse whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * STEP 2 query set - exactly 4 UNBRANDED DISCOVERY QUERIES built from the
 * service keywords and (optional) location. No business name: this is how
 * a customer searches when they do NOT yet know the business exists.
 */
function buildDiscoveryQueries(serviceKeywords, location) {
  const kw = (serviceKeywords || [])
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean);
  const k0 = kw[0] || 'services';
  const k1 = kw[1] || k0;
  const k2 = kw[2] || k0;
  const inLoc = location ? ` in ${location}` : '';
  const trailLoc = location ? ` ${location}` : '';
  return [
    `best ${k0}${inLoc}`,
    `top ${k1}${trailLoc}`,
    `${k0}${inLoc}`,
    `${k2} agency${trailLoc}`,
  ];
}

/** Clamp a parsed integer into the 0-10 range; 0 on failure. */
function clamp10(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * Pull a 1-10 self-assessed score out of a brand-awareness reply. Tries
 * the most explicit phrasings first ("8/10", "8 out of 10"), then a
 * number following scale/rate/confidence/score. Returns 0 when no number
 * is found - honest: no signal means no score.
 */
function extractTenScore(text) {
  if (!text) return 0;
  const t = String(text);
  let m = t.match(/(\d{1,2})\s*(?:\/|out of)\s*10\b/i);
  if (m) return clamp10(m[1]);
  m = t.match(/\b(?:scale|rate|rating|score|confidence)[^.\d]{0,40}?(\d{1,2})\b/i);
  if (m) return clamp10(m[1]);
  return 0;
}

/** POST a prompt to Claude (no analyst system prompt) and return its text. */
async function anthropicText(env, prompt, maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return data?.content?.map((b) => b.text).join('') || '';
}

/**
 * POST a prompt to Claude with the Anthropic web search tool enabled.
 * When tools run, the response `content` array interleaves text blocks with
 * server-side tool_use / web_search_tool_result blocks. Keep only the
 * `type: "text"` blocks and join them. Throws on HTTP error.
 */
async function anthropicWebSearch(env, prompt, maxUses = 3) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** POST a prompt to OpenAI chat completions as plain prose (no JSON mode).
 *  Used as the graceful fallback when the Responses API is unavailable. */
async function openaiText(env, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * POST a prompt to the OpenAI Responses API with live web search enabled.
 * The Responses API returns an `output` array of items; the assistant text
 * lives in the item with type "message", whose `content` array holds one or
 * more `output_text` parts. Concatenate those parts. Throws on HTTP error or
 * if no message text is found, so the caller can fall back.
 */
async function openaiWebSearch(env, prompt) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_SEARCH_MODEL,
      tools: [{ type: 'web_search_preview' }],
      input: prompt,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI Responses ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error(`OpenAI Responses: ${data.error?.message || 'error'}`);

  // Some SDKs expose a convenience `output_text`; prefer it when present.
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const message = output.find((item) => item && item.type === 'message');
  const parts = Array.isArray(message?.content) ? message.content : [];
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (!text) throw new Error('OpenAI Responses: no message text');
  return text;
}

/**
 * STEP 2 - Live discovery (the only honest signal). Run each unbranded
 * query through Perplexity (sonar). For each, store the query, the full
 * response, and a hard case-insensitive check of whether the business
 * name appears. No estimation, no AI guessing - a boolean match only.
 */
async function runDiscovery(env, businessName, queries) {
  const nameLower = (businessName || '').toLowerCase().trim();
  return Promise.all(
    (queries || []).map(async (query) => {
      let raw = '';
      try {
        raw = await callPerplexity(env, query);
      } catch (err) {
        console.error('Perplexity discovery failed:', query, err);
        raw = '';
      }
      const appeared = nameLower.length > 1 && raw.toLowerCase().includes(nameLower);
      return { query, response: stripMarkdown(raw), appeared };
    }),
  );
}

/**
 * STEP 3 - Competitor extraction. One Claude Haiku call over all four
 * Perplexity responses combined; returns the recommended business names.
 */
async function extractCompetitors(env, discoveryResults, location, businessName) {
  const combined = (discoveryResults || [])
    .map((r, i) => `Result ${i + 1} (query: "${r.query}"):\n${r.response}`)
    .join('\n\n');
  const prompt =
    `From these Perplexity search results, extract the names of specific businesses that were ` +
    `recommended or mentioned as service providers. Location context: ${location || 'not specified'}. ` +
    `Only extract actual business names, not generic descriptions. If location was provided, ` +
    `only include businesses that are explicitly mentioned in the search results as being based in or ` +
    `serving that location -- exclude any national brands or businesses with no clear local connection. ` +
    `If fewer than 8 local businesses are identified, return only those -- do not pad the list with ` +
    `national or non-local businesses. ` +
    `Do not include the business being analysed in the results. The business being analysed is: ` +
    `${businessName || 'unknown'}. If it appears in the Perplexity results, exclude it from the ` +
    `returned array. ` +
    `Return as a JSON array of unique business ` +
    `names, maximum 8. Return only the JSON array.\n\n${combined}`;
  try {
    const text = await anthropicText(env, prompt, 512);
    const arr = extractJsonArray(text);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((c) => (typeof c === 'string' ? c.trim() : ''))
      .filter(Boolean)
      .slice(0, 8);
  } catch (err) {
    console.error('Competitor extraction failed:', err);
    return [];
  }
}

/**
 * Build the brand-recommendation prompt. The prompt asks ONLY for the top
 * providers in the category - the business being tested is never mentioned,
 * so its appearance is an unbiased signal. Claude gets a "name in bold"
 * instruction; ChatGPT does not (bold is applied on the display side).
 */
function brandRecommendationPrompt(service, location, bold) {
  const head = location
    ? `Search the web for the top 5 ${service} agencies based in ${location}, UK. ` +
      `Only include agencies physically located in ${location}.`
    : `Search the web for the top 5 ${service} agencies in the UK.`;
  const nameFmt = bold
    ? `For each one give their name in bold and one sentence about what they do.`
    : `For each one give their name and one sentence about what they do.`;
  return `${head} ${nameFmt} Number them 1 to 5.`;
}

/**
 * Clean a brand response for storage WHILE PRESERVING the numbered-list
 * structure: strip citation markers and code ticks, collapse runs of spaces
 * but keep newlines (and the `**bold**` markers Claude adds) so the report
 * page can render a proper numbered list.
 */
function cleanBrandResponse(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[\d+\]/g, '')
    .replace(/`+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Find the 1-based list position at which the business name first appears in
 * a numbered response (0 if it appears outside any numbered item or not at
 * all). Used to award a position bonus to the score.
 */
function appearancePosition(text, businessName) {
  const nameLower = (businessName || '').toLowerCase().trim();
  if (!nameLower) return 0;
  for (const line of String(text || '').split(/\n+/)) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (m && m[2].toLowerCase().includes(nameLower)) return parseInt(m[1], 10);
  }
  return 0;
}

/**
 * Appearance-based score. Not appearing in the top recommendations is the
 * key negative signal (score 20). Appearing scores 75, with a bonus for
 * ranking first (95), second (85) or third (75).
 */
function brandScoreFromAppearance(appeared, position) {
  if (!appeared) return 20;
  if (position === 1) return 95;
  if (position === 2) return 85;
  if (position === 3) return 75;
  return 75;
}

/**
 * STEP 4 - Claude brand visibility via the Anthropic web search tool. Asks
 * only for the category's top providers (no business name in the prompt),
 * then checks programmatically whether the business appears and scores by
 * appearance + position. Stores the list prose, the 0-100 score, and an
 * `appeared` boolean.
 */
async function claudeBrandAwareness(env, businessName, serviceKeywords, location) {
  const service =
    (serviceKeywords || []).map((k) => (typeof k === 'string' ? k.trim() : '')).find(Boolean) ||
    'businesses';
  const prompt = brandRecommendationPrompt(service, location, true);
  const nameLower = (businessName || '').toLowerCase().trim();
  try {
    const raw = await anthropicWebSearch(env, prompt, 3);
    const response = cleanBrandResponse(raw);
    const appeared = !!(nameLower && response.toLowerCase().includes(nameLower));
    const brandScore = brandScoreFromAppearance(appeared, appearancePosition(response, businessName));
    return { response, brandScore, appeared };
  } catch (err) {
    console.error('Claude brand awareness failed:', err);
    return { response: '', brandScore: 0, appeared: false };
  }
}

/**
 * STEP 5 - ChatGPT brand visibility via the OpenAI Responses API with live
 * web search (falls back to gpt-4.1 chat completions). Same no-business
 * prompt + appearance/position scoring as Claude. Stores prose, 0-100 score,
 * and an `appeared` boolean.
 */
async function chatgptBrandAwareness(env, businessName, serviceKeywords, location) {
  const service =
    (serviceKeywords || []).map((k) => (typeof k === 'string' ? k.trim() : '')).find(Boolean) ||
    'businesses';
  const prompt = brandRecommendationPrompt(service, location, false);
  const nameLower = (businessName || '').toLowerCase().trim();
  let raw = '';
  try {
    raw = await openaiWebSearch(env, prompt);
  } catch (err) {
    console.error('ChatGPT Responses API failed, falling back to chat completions:', err);
    try {
      raw = await openaiText(env, prompt);
    } catch (err2) {
      console.error('ChatGPT brand awareness failed:', err2);
      return { response: '', brandScore: 0, appeared: false };
    }
  }
  const response = cleanBrandResponse(raw);
  const appeared = !!(nameLower && response.toLowerCase().includes(nameLower));
  const brandScore = brandScoreFromAppearance(appeared, appearancePosition(response, businessName));
  return { response, brandScore, appeared };
}

/**
 * Domains to exclude from Google "who is ranking" results - directories and
 * social platforms, not actual competitor agencies.
 */
const EXCLUDED_RESULT_DOMAINS = [
  'reddit.com',
  'instagram.com',
  'facebook.com',
  'linkedin.com',
  'youtube.com',
  'twitter.com',
  'yelp.com',
  'tripadvisor.com',
  'yell.com',
  'checkatrade.com',
];

/**
 * NEW STEP - Google rankings via SerpAPI. For the top 3 service keywords,
 * check where the submitted domain ranks in UK Google organic results and
 * capture the top 3 organic results per query (who IS ranking). The whole
 * thing is wrapped so any failure degrades gracefully to null - the report
 * still generates without Google data.
 */
async function runGoogleRankings(env, websiteUrl, serviceKeywords, location) {
  if (!env.SERPAPI_KEY) return { googleResults: null, googleScore: null };
  const domain = (hostnameFromUrl(websiteUrl) || '').toLowerCase();
  const keywords = (serviceKeywords || [])
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
  if (!domain || keywords.length === 0) return { googleResults: null, googleScore: null };

  try {
    const googleResults = await Promise.all(
      keywords.map(async (keyword) => {
        // Append "agency" unless the keyword already implies a provider type,
        // so generic service terms ("SEO") still surface agencies. Normalise
        // to UK English first so search queries match UK spellings.
        const normalisedKeyword = toUkEnglish(keyword);
        const hasProviderWord = /\b(agency|studio|services|company)\b/i.test(normalisedKeyword);
        const term = hasProviderWord ? normalisedKeyword : `${normalisedKeyword} agency`;
        const q = location ? `${term} ${location}` : term;
        const url =
          `https://serpapi.com/search.json?q=${encodeURIComponent(q)}` +
          `&location=United+Kingdom&hl=en&gl=uk&api_key=${encodeURIComponent(env.SERPAPI_KEY)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
        const data = await res.json();
        if (data && data.error) throw new Error(`SerpAPI: ${data.error}`);
        const organic = Array.isArray(data.organic_results) ? data.organic_results : [];

        // First result within the top 10 whose link is on the submitted domain.
        let position = null;
        const topTen = organic.slice(0, 10);
        for (let i = 0; i < topTen.length; i++) {
          const link = String((topTen[i] && topTen[i].link) || '').toLowerCase();
          if (link.includes(domain)) {
            position = i + 1;
            break;
          }
        }
        const found = position !== null;
        // Drop directories / social platforms - these are not competitor
        // agencies - then keep the top 3 real results.
        const topResults = organic
          .filter((r) => {
            const link = String(r?.link || '').toLowerCase();
            return link && !EXCLUDED_RESULT_DOMAINS.some((d) => link.includes(d));
          })
          .slice(0, 3)
          .map((r) => ({
            title: String(r?.title || ''),
            link: String(r?.link || ''),
          }));
        return { keyword, position: found ? position : 'Not in top 10', found, topResults };
      }),
    );

    // Position → score: 1-3 = 100, 4-6 = 75, 7-10 = 50, not found = 0.
    const scoreFor = (item) => {
      if (!item.found || typeof item.position !== 'number') return 0;
      if (item.position <= 3) return 100;
      if (item.position <= 6) return 75;
      if (item.position <= 10) return 50;
      return 0;
    };
    const avg = googleResults.reduce((sum, r) => sum + scoreFor(r), 0) / googleResults.length;
    const googleScore = Math.round(avg * 10) / 10;
    return { googleResults, googleScore };
  } catch (err) {
    console.error('SerpAPI rankings failed:', err);
    return { googleResults: null, googleScore: null };
  }
}

/* ------------------------------------------------------------------ */
/* Model calls - each returns a normalised result; never throws.       */
/* ------------------------------------------------------------------ */

/** POST a single prompt to Perplexity and return its prose. Throws on error. */
async function callPerplexity(env, content) {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Extract 3–5 specific service keywords describing what the business does,
 * plus the actual trading name of the business, using a fast Claude Haiku
 * call against the page metadata. The keywords drive the service-specific
 * search queries every model is then tested against; the business name is
 * used in preference to the cleaned page title.
 * Returns { keywords: [], businessName: null } on any failure.
 */
async function extractServiceKeywords(env, { businessName, pageTitle, metaDescription, headingText, location }) {
  try {
    const prompt =
      `Based on this website information, extract two things:\n` +
      `1. "businessName": the actual trading name of the business -- the name as it would appear in a ` +
      `directory listing -- separately from any tagline or service description. If the page title is a ` +
      `tagline or descriptor (e.g. "Salesforce Consultants for Nonprofits") rather than the trading name, ` +
      `infer the real business name from the rest of the content; if it genuinely cannot be determined, ` +
      `use an empty string.\n` +
      `2. "keywords": 3 to 5 specific service keywords or phrases that describe what this business does.\n` +
      `Return ONLY a JSON object of the form ` +
      `{"businessName": "...", "keywords": ["...", "..."]}, nothing else.\n` +
      `Business name hint: ${businessName || 'unknown'}\n` +
      `Page title: ${pageTitle || 'unknown'}\n` +
      `Meta description: ${metaDescription || 'unknown'}\n` +
      `Page heading: ${headingText || 'unknown'}\n` +
      `Location: ${location || 'not specified'}\n` +
      `Example output: {"businessName": "Acme Studio", "keywords": ["web design agency", ` +
      `"branding studio", "digital marketing", "WordPress development"]}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic keywords ${res.status}`);
    const data = await res.json();
    const text = data?.content?.map((b) => b.text).join('') || '';
    const obj = extractJsonObject(text);
    const rawKeywords = obj && Array.isArray(obj.keywords) ? obj.keywords : [];
    const keywords = rawKeywords
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean)
      // Normalise US English spellings to UK English equivalents.
      .map((k) => toUkEnglish(k))
      .slice(0, 5);
    const extractedName =
      obj && typeof obj.businessName === 'string' ? obj.businessName.trim() : '';
    return { keywords, businessName: extractedName || null };
  } catch (err) {
    console.error('Keyword extraction failed:', err);
    return { keywords: [], businessName: null };
  }
}

/**
 * STEP 7 - Recommendations. One Claude Haiku call over the full picture;
 * focuses on the gap between this business and the competitors that appear
 * instead of it. Returns exactly 5 actionable items.
 */
async function generateRecommendations(env, ctx) {
  const {
    businessName, discoveryScore, appearanceCount, brandScore, chatgptBrandScore,
    googleResults, googleScore, competitors, serviceKeywords, location, queries,
  } = ctx;
  const fallback = defaultRecommendations();
  try {
    const googleClause =
      Array.isArray(googleResults) && googleResults.length
        ? `Google rankings (UK search), Google score ${googleScore}/100: ` +
          googleResults
            .map((g) => `"${g.keyword}" -> ${g.found ? 'position ' + g.position : 'not in top 10'}`)
            .join('; ') +
          `. `
        : `Google ranking data was unavailable for this report. `;
    const prompt =
      `Generate 5 specific actionable recommendations to improve AI search visibility for ${businessName}. ` +
      `Context: Discovery score ${discoveryScore}/100 (appeared in ${appearanceCount} of 4 live Perplexity ` +
      `searches). Brand awareness -- Claude score ${brandScore}/100, ChatGPT score ${chatgptBrandScore}/100. ` +
      googleClause +
      `Competitors appearing instead: ${(competitors || []).join(', ') || 'none identified'}. ` +
      `Service keywords: ${(serviceKeywords || []).join(', ') || 'not specified'}. ` +
      `Location: ${location || 'not specified'}. ` +
      `Queries tested: ${(queries || []).join(', ')}. ` +
      `When a location is provided, always evaluate whether Google Business Profile optimisation and ` +
      `local map pack visibility should feature as recommendations -- these directly influence both ` +
      `local Google rankings and AI search citation, and should be included if the business is not ` +
      `clearly already ranking in the map pack for their key service terms. ` +
      `Return JSON array of 5 objects with: title, description (2 to 3 sentences, specific and actionable), ` +
      `priority ('high'|'medium'|'low'), effort ('quick'|'medium'|'significant'). ` +
      `Make specific recommendations about improving both Google rankings and AI visibility, focusing on ` +
      `the gap between their scores and their competitors.`;
    const text = await anthropicText(env, prompt, 1536);
    const arr = extractJsonArray(text);
    if (!Array.isArray(arr) || arr.length === 0) return fallback;
    return arr.slice(0, 5).map((r) => ({
      title: String(r?.title || 'Recommendation'),
      description: String(r?.description || ''),
      priority: ['high', 'medium', 'low'].includes(r?.priority) ? r.priority : 'medium',
      effort: ['quick', 'medium', 'significant'].includes(r?.effort) ? r.effort : 'medium',
    }));
  } catch (err) {
    console.error('Recommendations failed:', err);
    return fallback;
  }
}

function defaultRecommendations() {
  return [
    {
      title: 'Build authority for your service category, not just your name',
      description:
        'AI systems only recommend you in unbranded "best [service] in [town]" searches if independent sources establish you as a category leader. Prioritise reviews, trade directory listings and local press that name your service and location together.',
      priority: 'high',
      effort: 'significant',
    },
    {
      title: 'Create category-defining service and location pages',
      description:
        'Publish pages that directly answer the category searches customers actually use - e.g. "[service] in [town]" - with clear evidence, FAQs and structured content AI systems can extract and cite when recommending a provider.',
      priority: 'high',
      effort: 'medium',
    },
    {
      title: 'Implement comprehensive schema markup',
      description:
        'Add Organisation, WebSite, LocalBusiness, Service, and FAQPage schema across your site so AI systems can identify your business as a coherent entity in your service category.',
      priority: 'high',
      effort: 'medium',
    },
    {
      title: 'Standardise your entity across the web',
      description:
        'Make your business name, address, services and contact details identical on your website, Google Business Profile, and every directory you appear in, so AI systems associate you confidently with your category.',
      priority: 'medium',
      effort: 'medium',
    },
    {
      title: 'Add an llms.txt file to your domain root',
      description:
        'Publish a plain-text llms.txt describing your business, service category and key pages. Several major AI systems already check for this file.',
      priority: 'medium',
      effort: 'quick',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function scoreColour(score) {
  if (score <= 25) return '#EF4444'; // 0-25 red
  if (score <= 50) return '#F59E0B'; // 26-50 amber
  if (score <= 75) return '#0C7B82'; // 51-75 teal
  return '#16A34A'; // 76-100 green
}

function buildEmailHtml({ firstName, businessName, overallScore, reportUrl, platforms }) {
  const colour = scoreColour(overallScore);
  const barPct = Math.max(2, Math.min(100, overallScore));

  // Per-platform breakdown, each listing the exact queries we tested.
  const list = Array.isArray(platforms) ? platforms : [];
  const queriesSet =
    list.find((p) => Array.isArray(p?.result?.queriesChecked) && p.result.queriesChecked.length)
      ?.result.queriesChecked || [];

  const platformRows = list
    .map((p) => {
      const r = p.result || {};
      const pColour = scoreColour(r.score || 0);
      const foundLabel = r.found ? 'Found' : 'Not found';
      const foundColour = r.found ? '#0A6970' : '#DC2626';
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #EEF2F7;">
            <span style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#0D1321;">${p.name}</span>
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #EEF2F7;text-align:right;">
            <span style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:${pColour};">${r.score || 0}<span style="color:#94A3B8;font-weight:600;">/100</span></span>
            <span style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${foundColour};margin-left:8px;">${foundLabel}</span>
          </td>
        </tr>`;
    })
    .join('');

  const queriesItems = queriesSet
    .map(
      (q) =>
        `<li style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#475569;">&ldquo;${q}&rdquo;</li>`,
    )
    .join('');

  const breakdownBlock =
    list.length === 0
      ? ''
      : `
            <tr>
              <td style="padding:28px 40px 0;">
                <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;font-family:Helvetica,Arial,sans-serif;margin-bottom:4px;">Score by platform</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${platformRows}</table>
              </td>
            </tr>${
              queriesItems
                ? `
            <tr>
              <td style="padding:24px 40px 0;">
                <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;font-family:Helvetica,Arial,sans-serif;margin-bottom:6px;">Searches we tested</div>
                <ul style="margin:0;padding-left:18px;">${queriesItems}</ul>
              </td>
            </tr>`
                : ''
            }`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#F7F9FC;font-family:Helvetica,Arial,sans-serif;color:#0D1321;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FC;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E4E8EF;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 8px;">
                <img src="https://foundeverywhere.co.uk/images/email-logo.png" alt="Found Everywhere" width="180" height="50" style="display:block;width:180px;height:auto;border:0;outline:none;text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 0;font-size:16px;line-height:1.6;color:#0D1321;">
                <p style="margin:16px 0 0;">Hi ${firstName},</p>
                <p style="margin:16px 0 0;">Your free AI Visibility and Google Search Report for <strong>${businessName}</strong> is ready.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FC;border:1px solid #E4E8EF;border-radius:12px;">
                  <tr>
                    <td style="padding:24px;text-align:center;">
                      <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;font-family:Helvetica,Arial,sans-serif;">Your Visibility Score</div>
                      <div style="font-size:44px;font-weight:700;color:${colour};margin:8px 0;font-family:Helvetica,Arial,sans-serif;">${overallScore}<span style="font-size:22px;color:#94A3B8;">/100</span></div>
                      <div style="height:8px;background:#E4E8EF;border-radius:999px;overflow:hidden;">
                        <div style="height:8px;width:${barPct}%;background:${colour};border-radius:999px;"></div>
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>${breakdownBlock}
            <tr>
              <td style="padding:24px 40px 0;font-size:15px;line-height:1.65;color:#475569;">
                <p style="margin:0;">We checked ${businessName} across Google search and three AI platforms. Your report includes visibility scores, a breakdown by platform, the exact searches we tested, and five specific recommendations to improve.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 40px 8px;" align="center">
                <a href="${reportUrl}" style="display:inline-block;background:#0C7B82;color:#FFFFFF;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;">View Your Full Report</a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #E4E8EF;font-size:12px;line-height:1.6;color:#94A3B8;text-align:center;">
                Found Everywhere &middot; <a href="https://foundeverywhere.co.uk" style="color:#94A3B8;">foundeverywhere.co.uk</a> &middot; <a href="mailto:hello@foundeverywhere.co.uk" style="color:#94A3B8;">hello@foundeverywhere.co.uk</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendEmail(env, { firstName, businessName, email, overallScore, reportUrl, platforms }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Found Everywhere <hello@foundeverywhere.co.uk>',
        to: email,
        subject: `Your Search and AI Visibility Report for ${businessName} is Ready`,
        html: buildEmailHtml({ firstName, businessName, overallScore, reportUrl, platforms }),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend ${res.status}: ${body}`);
    }
    return true;
  } catch (err) {
    console.error('Email send failed:', err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Route handlers                                                      */
/* ------------------------------------------------------------------ */

async function handleGenerateReport(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ success: false, message: 'Invalid JSON body.' }, 400, env);
  }

  const firstName = (payload.firstName || '').toString().trim();
  const websiteUrl = (payload.websiteUrl || '').toString().trim();
  const location = (payload.location || '').toString().trim();
  const email = (payload.email || '').toString().trim().toLowerCase();

  // Business name and sector are no longer collected from the form - they
  // are inferred from the website's own page content (see below). Location
  // is optional.
  if (!firstName || !websiteUrl || !email) {
    return json(
      { success: false, message: 'First name, website URL, and email are required.' },
      400,
      env,
    );
  }

  /* Step 1 - rate limit by email (24h TTL). */
  const rateKey = `email:${email}`;
  const existing = await env.REPORT_REQUESTS.get(rateKey);
  if (existing) {
    return json(
      {
        success: false,
        message:
          'You have already requested a report for this email address. Check your inbox.',
      },
      429,
      env,
    );
  }
  await env.REPORT_REQUESTS.put(rateKey, '1', { expirationTtl: 60 * 60 * 24 });

  /* STEP 1 - infer the business from the site's own page content, then
     extract the specific services it offers (drives the discovery queries). */
  const meta = await fetchSiteMeta(websiteUrl);
  const pageTitle = meta.title || '';
  const metaDescription = meta.description || '';
  const headingText = meta.heading || '';
  const cleanedTitle =
    cleanBusinessName(meta.title) || hostnameFromUrl(websiteUrl) || 'this business';
  const { keywords: serviceKeywords, businessName: extractedBusinessName } =
    await extractServiceKeywords(env, {
      businessName: cleanedTitle,
      pageTitle,
      metaDescription,
      headingText,
      location,
    });
  // Prefer the trading name Claude extracted; fall back to the cleaned page
  // title only when no business name was returned.
  const businessName = extractedBusinessName || cleanedTitle;

  /* STEP 2 - live discovery via Perplexity (the only honest signal). Four
     unbranded queries; hard boolean appearance check per query. */
  const discoveryQueries = buildDiscoveryQueries(serviceKeywords, location);
  // Kick off Google rankings (SerpAPI) in parallel with the AI discovery work.
  const googlePromise = runGoogleRankings(env, websiteUrl, serviceKeywords, location);
  const discoveryResults = await runDiscovery(env, businessName, discoveryQueries);
  const appearanceCount = discoveryResults.filter((r) => r.appeared).length;
  const discoveryScore = (appearanceCount / 4) * 100; // 0, 25, 50, 75 or 100

  /* STEPS 3–5 - Google rankings + competitor extraction + both brand checks. */
  const [googleData, competitors, claude, chatgpt] = await Promise.all([
    googlePromise,
    extractCompetitors(env, discoveryResults, location, businessName),
    claudeBrandAwareness(env, businessName, serviceKeywords, location),
    chatgptBrandAwareness(env, businessName, serviceKeywords, location),
  ]);
  const { googleResults, googleScore } = googleData;
  const claudeBrandResponse = claude.response;
  const brandScore = claude.brandScore;
  const claudeAppeared = claude.appeared;
  const chatgptBrandResponse = chatgpt.response;
  const chatgptBrandScore = chatgpt.brandScore;
  const chatgptAppeared = chatgpt.appeared;

  /* STEP 6 - overall score. With Google data: discovery 40%, Google 35%,
     each brand 12.5%. Without it: discovery 60%, each brand 20%. */
  const round1 = (n) => Math.round(n * 10) / 10;
  const hasGoogle = googleScore !== null && googleScore !== undefined;
  const overallScore = hasGoogle
    ? round1(
        discoveryScore * 0.4 + googleScore * 0.35 + brandScore * 0.125 + chatgptBrandScore * 0.125,
      )
    : round1(discoveryScore * 0.6 + brandScore * 0.2 + chatgptBrandScore * 0.2);

  /* STEP 7 - recommendations focused on the discovery/competitor gap. */
  const recommendations = await generateRecommendations(env, {
    businessName,
    discoveryScore,
    appearanceCount,
    brandScore,
    chatgptBrandScore,
    googleResults,
    googleScore,
    competitors,
    serviceKeywords,
    location,
    queries: discoveryQueries,
  });

  /* STEP 8 - persist (30 day TTL) + email. */
  const id = crypto.randomUUID();
  const report = {
    id,
    firstName,
    businessName,
    websiteUrl,
    location,
    metaDescription,
    serviceKeywords,
    discoveryQueries,
    discoveryResults,
    appearanceCount,
    discoveryScore,
    googleResults,
    googleScore,
    competitors,
    claudeBrandResponse,
    brandScore,
    claudeAppeared,
    chatgptBrandResponse,
    chatgptBrandScore,
    chatgptAppeared,
    overallScore,
    recommendations,
    email,
    generatedAt: new Date().toISOString(),
  };
  await env.REPORTS.put(`report:${id}`, JSON.stringify(report), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  const reportUrl = `https://foundeverywhere.co.uk/report/${id}`;
  const emailPlatforms = [
    {
      name: 'Perplexity discovery',
      result: {
        score: discoveryScore,
        found: appearanceCount > 0,
        queriesChecked: discoveryQueries,
      },
    },
    { name: 'Claude brand awareness', result: { score: brandScore, found: brandScore >= 50 } },
    {
      name: 'ChatGPT brand awareness',
      result: { score: chatgptBrandScore, found: chatgptBrandScore >= 50 },
    },
  ];
  await sendEmail(env, {
    firstName,
    businessName,
    email,
    overallScore,
    reportUrl,
    platforms: emailPlatforms,
  });

  /* STEP 9 - respond. */
  return json(
    {
      success: true,
      reportId: id,
      overallScore,
      message: `Report sent to ${email}`,
    },
    200,
    env,
  );
}

/* ------------------------------------------------------------------ */
/* Meta-title fetch (auto-fills the business name on the form)         */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  if (!html) return null;
  // Prefer og:title (content can come before or after the property attr).
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (og && og[1]) return decodeEntities(og[1]) || null;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title && title[1]) return decodeEntities(title[1]) || null;
  return null;
}

function extractDescription(html) {
  if (!html) return null;
  // Prefer the standard meta description, then fall back to og:description.
  const desc =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  if (desc && desc[1]) {
    const d = decodeEntities(desc[1]);
    if (d) return d;
  }
  const og =
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["']/i);
  if (og && og[1]) return decodeEntities(og[1]) || null;
  return null;
}

/** Pull the text of the first <h1> on the page, tags stripped. */
function extractHeading(html) {
  if (!html) return null;
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m || !m[1]) return null;
  // Strip any nested tags, then decode entities / collapse whitespace.
  const text = m[1].replace(/<[^>]+>/g, ' ');
  const cleaned = decodeEntities(text);
  if (!cleaned) return null;
  return cleaned.length > 200 ? cleaned.slice(0, 200).trim() : cleaned;
}

/**
 * Turn a raw page <title> into a clean business name: drop everything
 * after the first separator (| - – - :) and cap at 50 chars.
 */
function cleanBusinessName(rawTitle) {
  if (!rawTitle) return null;
  let name = String(rawTitle).trim();
  // Cut at the first common title separator.
  name = name.split(/\s*[|\-–—:]\s*/)[0].trim();
  if (!name) return null;
  if (name.length > 50) name = name.slice(0, 50).trim();
  return name || null;
}

function hostnameFromUrl(rawUrl) {
  try {
    let target = String(rawUrl).trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    return new URL(target).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}/**
 * Fetch a URL and pull its title, description and first H1. Returns
 * { title, description, heading } with null fields on any failure -
 * never throws.
 */
async function fetchSiteMeta(rawUrl) {
  const empty = { title: null, description: null, heading: null };
  if (!rawUrl) return empty;
  try {
    let target = rawUrl.trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return empty;
    const res = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FoundEverywhereBot/1.0; +https://foundeverywhere.co.uk)',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
    if (!res.ok) return empty;
    const html = await res.text();
    return {
      title: extractTitle(html),
      description: extractDescription(html),
      heading: extractHeading(html),
    };
  } catch (err) {
    console.error('fetchSiteMeta failed:', err);
    return empty;
  }
}

async function handleFetchMeta(rawUrl, env) {
  const { title } = await fetchSiteMeta(rawUrl);
  return json({ title }, 200, env);
}

async function handleGetReport(id, env, requestUrl) {
  console.log(`[api/report] request=${requestUrl || '(unknown)'} extractedId=${id}`);
  if (!id) return json({ success: false, message: 'Missing report id.' }, 400, env);
  const key = `report:${id}`;
  const raw = await env.REPORTS.get(key);
  console.log(`[api/report] lookup key=${key} found=${!!raw}`);
  if (!raw) {
    return json({ success: false, message: 'Report not found.' }, 404, env);
  }
  return new Response(raw, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

/* ------------------------------------------------------------------ */
/* Contact form                                                        */
/* ------------------------------------------------------------------ */

/** Escape user-supplied text before interpolating into email HTML. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Internal notification email - plain, scannable detail table. */
function buildContactNotificationHtml(d) {
  const rows = [
    ['Name', `${d.firstName} ${d.lastName}`.trim()],
    ['Email', d.email],
    ['Website', d.websiteUrl || '-'],
    ['How can we help', d.helpWith || '-'],
    ['Message', d.message],
  ]
    .map(
      ([label, value]) => `
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #EEF2F7;vertical-align:top;width:150px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#64748B;">${escapeHtml(label)}</td>
              <td style="padding:12px 16px;border-bottom:1px solid #EEF2F7;vertical-align:top;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#0D1321;white-space:pre-wrap;">${escapeHtml(value)}</td>
            </tr>`,
    )
    .join('');

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#FFFFFF;font-family:Helvetica,Arial,sans-serif;color:#0D1321;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td style="padding:8px 16px 16px;">
                <h1 style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:#0D1321;">New enquiry from ${escapeHtml(`${d.firstName} ${d.lastName}`.trim())}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #EEF2F7;border-radius:10px;border-collapse:separate;overflow:hidden;">${rows}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 16px;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#94A3B8;">
                Sent from foundeverywhere.co.uk contact form.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Confirmation email to the submitter - branded, matches the report email. */
function buildContactConfirmationHtml(d) {
  const summary = [
    ['Name', `${d.firstName} ${d.lastName}`.trim()],
    ['Email', d.email],
    ['Website', d.websiteUrl || '-'],
    ['How can we help', d.helpWith || '-'],
    ['Message', d.message],
  ]
    .map(
      ([label, value]) => `
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #EEF2F7;vertical-align:top;width:140px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#64748B;">${escapeHtml(label)}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #EEF2F7;vertical-align:top;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#0D1321;white-space:pre-wrap;">${escapeHtml(value)}</td>
                  </tr>`,
    )
    .join('');

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#F7F9FC;font-family:Helvetica,Arial,sans-serif;color:#0D1321;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FC;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E4E8EF;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 8px;">
                <img src="https://foundeverywhere.co.uk/images/email-logo.png" alt="Found Everywhere" width="180" height="50" style="display:block;width:180px;height:auto;border:0;outline:none;text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 0;font-size:16px;line-height:1.6;color:#0D1321;">
                <p style="margin:16px 0 0;">Hi ${escapeHtml(d.firstName)},</p>
                <p style="margin:16px 0 0;">Thanks for getting in touch. We have received your message and will come back to you shortly.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 0;">
                <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;font-family:Helvetica,Arial,sans-serif;margin-bottom:4px;">What you sent us</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${summary}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 40px 32px;border-top:1px solid #E4E8EF;font-size:12px;line-height:1.6;color:#94A3B8;text-align:center;">
                Found Everywhere - <a href="https://foundeverywhere.co.uk" style="color:#94A3B8;">foundeverywhere.co.uk</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Fire one Resend email; never throws - returns true/false. */
async function sendResendEmail(env, payload) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend ${res.status}: ${body}`);
    }
    return true;
  } catch (err) {
    console.error('Contact email send failed:', err);
    return false;
  }
}

async function handleContact(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Please fill in all required fields.' }, 400, env);
  }

  const firstName = (payload.firstName || '').toString().trim();
  const lastName = (payload.lastName || '').toString().trim();
  const email = (payload.email || '').toString().trim();
  const websiteUrl = (payload.websiteUrl || '').toString().trim();
  const helpWith = (payload.helpWith || '').toString().trim();
  const message = (payload.message || '').toString().trim();

  // Required: first name, email, message.
  if (!firstName || !email || !message) {
    return json({ error: 'Please fill in all required fields.' }, 400, env);
  }

  const details = { firstName, lastName, email, websiteUrl, helpWith, message };
  const fullName = `${firstName} ${lastName}`.trim();

  // Both emails are best-effort. A failure here must NOT surface to the user.
  await Promise.all([
    sendResendEmail(env, {
      from: 'Found Everywhere Website <hello@foundeverywhere.co.uk>',
      to: 'hello@foundeverywhere.co.uk',
      reply_to: email,
      subject: `New enquiry from ${fullName}`,
      html: buildContactNotificationHtml(details),
    }),
    sendResendEmail(env, {
      from: 'Found Everywhere <hello@foundeverywhere.co.uk>',
      to: email,
      subject: `Thanks for getting in touch, ${firstName}`,
      html: buildContactConfirmationHtml(details),
    }),
  ]);

  return json(
    { success: true, message: 'Thanks for getting in touch. We will be back in touch shortly.' },
    200,
    env,
  );
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === '/api/generate-report' && request.method === 'POST') {
      try {
        return await handleGenerateReport(request, env);
      } catch (err) {
        console.error('generate-report fatal:', err);
        return json(
          { success: false, message: 'Something went wrong generating your report.' },
          500,
          env,
        );
      }
    }

    const reportMatch = url.pathname.match(/^\/api\/report\/([^/]+)\/?$/);
    if (reportMatch && request.method === 'GET') {
      return handleGetReport(decodeURIComponent(reportMatch[1]), env, request.url);
    }

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      try {
        return await handleContact(request, env);
      } catch (err) {
        console.error('contact fatal:', err);
        // Even on an unexpected error, do not surface a backend failure;
        // the user's message may still have reached us.
        return json(
          { success: true, message: 'Thanks for getting in touch. We will be back in touch shortly.' },
          200,
          env,
        );
      }
    }

    if (url.pathname === '/api/fetch-meta' && request.method === 'GET') {
      return handleFetchMeta(url.searchParams.get('url'), env);
    }

    return json({ success: false, message: 'Not found.' }, 404, env);
  },
};
