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
 *   RESEND_API_KEY, TURNSTILE_SECRET_KEY
 *
 * Vars:
 *   ALLOWED_ORIGIN - e.g. https://foundeverywhere.co.uk
 */

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const PERPLEXITY_MODEL = 'sonar';
const OPENAI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT =
  'You are an AI visibility analyst. You will be given a business name, website, location, and the specific services it offers, then asked to judge how it performs for two kinds of search: unbranded discovery searches (where the customer does not know the business and is choosing a provider) and branded searches (where the customer already knows the name). Score unbranded results harshly — most businesses do not appear for category searches. Respond only with valid JSON matching the schema provided.';

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

/** Pull the first {...} JSON object out of a model's text response. */
function extractJson(text) {
  if (!text) return null;
  // Strip markdown code fences if present.
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

/** Normalise a model result into the shared schema, with safe defaults. */
function normaliseResult(parsed) {
  const score = clampScore(parsed && parsed.score);
  return {
    found: typeof parsed?.found === 'boolean' ? parsed.found : score >= 50,
    confidence: ['high', 'medium', 'low'].includes(parsed?.confidence)
      ? parsed.confidence
      : 'low',
    mentions: Array.isArray(parsed?.mentions) ? parsed.mentions.slice(0, 8) : [],
    context: typeof parsed?.context === 'string' ? stripMarkdown(parsed.context) : '',
    score,
    competitors: Array.isArray(parsed?.competitors)
      ? parsed.competitors
          .map((c) => (typeof c === 'string' ? c.trim() : ''))
          .filter(Boolean)
          .slice(0, 8)
      : [],
  };
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

function locationClause(location) {
  return location ? ` in ${location}` : '';
}

/**
 * SET 1 — UNBRANDED DISCOVERY QUERIES (70% of the score).
 *
 * These are the commercially important queries: how a customer searches
 * when they do NOT yet know the business exists. The business name is
 * deliberately excluded — only service keywords + location. Returns []
 * when no keywords are available.
 */
function buildUnbrandedQueries(serviceKeywords, location) {
  const kw = (serviceKeywords || [])
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean);
  if (kw.length === 0) return [];

  const queries = [];

  if (location) {
    // Local discovery: 4 location-specific queries, all pinned to the location.
    const loc = ` in ${location}`;
    queries.push(`best ${kw[0]}${loc}`);
    queries.push(`recommended ${kw[1] || kw[0]}${loc}`);
    queries.push(`top ${kw[2] || kw[0]} companies${loc}`);
    queries.push(`who should I use for ${kw[0]}${loc}`);
  } else {
    // National discovery: no location — frame queries UK-wide.
    queries.push(`best ${kw[0]} agency UK`);
    queries.push(`recommended ${kw[1] || kw[0]} service`);
    queries.push(`top ${kw[0]} companies`);
    queries.push(`who should I use for ${kw[0]}`);
  }

  // De-duplicate and cap at 4 discovery queries.
  return [...new Set(queries)].slice(0, 4);
}

/**
 * SET 2 — BRANDED QUERIES (30% of the score).
 *
 * Include the business name to test whether the AI systems actually know
 * about the business when asked directly. We always have a business name
 * (inferred from the site), so this set is never empty.
 */
function buildBrandedQueries(businessName, serviceKeywords, location) {
  const name = (businessName || 'this business').trim();
  const sector =
    (serviceKeywords || []).map((k) => (typeof k === 'string' ? k.trim() : '')).find(Boolean) ||
    'business';
  const loc = location ? ` in ${location}` : '';
  const queries = [
    `what does ${name} do`,
    `is ${name} a good ${sector}${loc}`,
  ];
  return [...new Set(queries)].slice(0, 2);
}

/**
 * Shape a Perplexity DISCOVERY result (live web search). Carries the
 * discovery score, the response excerpt and the competitors it surfaced.
 */
function buildDiscoveryResult(unbranded) {
  const discoveryScore = clampScore(unbranded?.score);
  return {
    found: !!unbranded?.found,
    confidence: unbranded?.confidence || 'low',
    mentions: Array.isArray(unbranded?.mentions) ? unbranded.mentions.slice(0, 8) : [],
    context: unbranded?.context || '',
    discoveryScore,
    score: discoveryScore,
    competitors: Array.isArray(unbranded?.competitors) ? unbranded.competitors : [],
  };
}

/**
 * Shape a Claude / ChatGPT BRAND RECOGNITION result (training-data
 * awareness). Carries the brand score only.
 */
function buildBrandResult(branded) {
  const brandScore = clampScore(branded?.score);
  return {
    found: !!branded?.found,
    confidence: branded?.confidence || 'low',
    mentions: Array.isArray(branded?.mentions) ? branded.mentions.slice(0, 8) : [],
    context: branded?.context || '',
    brandScore,
    score: brandScore,
  };
}

/**
 * Merge the competitor lists every model returned into one deduplicated
 * set of business names (case-insensitive), dropping the target business
 * itself. Capped at 12 for display.
 */
function aggregateCompetitors(results, businessName) {
  const out = new Map();
  const nameLower = (businessName || '').toLowerCase();
  for (const r of results) {
    for (const raw of (r && Array.isArray(r.competitors) ? r.competitors : [])) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name || name.length > 60) continue;
      const key = name.toLowerCase();
      if (key === nameLower || (nameLower && key.includes(nameLower))) continue;
      if (!out.has(key)) out.set(key, name);
    }
  }
  return [...out.values()].slice(0, 12);
}

/**
 * SET 2 prompt — branded. Tests whether the AI systems actually know the
 * business when asked about it by name.
 */
function brandedPrompt({ businessName, websiteUrl, location, serviceKeywords, brandedQueries }) {
  const loc = location || 'not specified';
  const services = (serviceKeywords || []).filter(Boolean);
  const queryLines = (brandedQueries || []).map((q) => `"${q}"`).join('\n');
  return (
    `You are checking whether AI assistants KNOW about a specific business when asked about it BY NAME.\n\n` +
    `Business: ${businessName}. Website: ${websiteUrl}. Location: ${loc}. ` +
    `This business offers: ${services.join(', ') || 'not specified'}.\n\n` +
    `Consider these branded queries:\n` +
    queryLines +
    `\n\n` +
    `Score 0-100 based on how much accurate, specific detail you can give about THIS business — its services, ` +
    `location and reputation — and whether it clearly exists as a recognised entity. If you have no real ` +
    `knowledge of this business, score low (0-25).\n\n` +
    `Return JSON: { found: boolean, confidence: 'high'|'medium'|'low', mentions: string[], ` +
    `context: string, score: number }`
  );
}

/* ------------------------------------------------------------------ */
/* Model calls - each returns a normalised result; never throws.       */
/* ------------------------------------------------------------------ */

/** POST a single prompt to Claude and return its raw text. Throws on error. */
async function callAnthropic(env, prompt, maxTokens = 1024) {
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
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return data?.content?.map((b) => b.text).join('') || '';
}

async function queryClaude(env, input) {
  // Claude = BRAND RECOGNITION only. Branded queries against training-data
  // awareness; it does not perform live discovery.
  try {
    const text = await callAnthropic(env, brandedPrompt(input));
    return buildBrandResult(normaliseResult(extractJson(text)));
  } catch (err) {
    console.error('Claude query failed:', err);
    return buildBrandResult(normaliseResult(null));
  }
}

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

async function queryPerplexity(env, input) {
  // Perplexity = LIVE SEARCH DISCOVERY only. It searches the real web, so we
  // use it exclusively for the unbranded discovery queries and treat its
  // results as the source of truth for competitors.
  const { businessName, location, serviceKeywords, unbrandedQueries } = input;
  const services = (serviceKeywords || []).filter(Boolean);
  const hasUnbranded = (unbrandedQueries || []).length > 0;
  const loc = locationClause(location);

  if (!hasUnbranded) {
    return buildDiscoveryResult({
      found: false, confidence: 'low', mentions: [], context: '', score: 0, competitors: [],
    });
  }

  try {
    // Strict competitor instruction: only businesses Perplexity's live
    // results explicitly tie to the location (or, with no location, real
    // national/UK competitors).
    const competitorInstruction = location
      ? `Then, on a final separate line, list ONLY the businesses whose results explicitly state they are based ` +
        `in or serve ${location}. Use exactly this format, giving each business's location: ` +
        `COMPETITORS: Name One — ${location}; Name Two — ${location}. ` +
        `Do NOT list any business unless its connection to ${location} is explicit in the results. ` +
        `If none qualify, write "COMPETITORS:" with nothing after it.`
      : `Then, on a final separate line, list the real national or UK-wide businesses recommended in these ` +
        `results, in exactly this format: COMPETITORS: Name One; Name Two; Name Three.`;

    const content =
      `Search the live web. A customer who does not know any specific provider is searching for these things: ` +
      (unbrandedQueries || []).map((q) => `"${q}"`).join(', ') +
      `. They are looking for ${services.join(', ') || 'this kind of business'}${loc}. ` +
      `Based on real current search results, which specific businesses actually appear, and does ` +
      `${businessName} appear among them? Give a brief factual answer describing what the results show. ` +
      competitorInstruction;

    const text = await callPerplexity(env, content);
    return buildDiscoveryResult(interpretPerplexityUnbranded(text, businessName, location));
  } catch (err) {
    console.error('Perplexity query failed:', err);
    return buildDiscoveryResult({
      found: false, confidence: 'low', mentions: [], context: '', score: 0, competitors: [],
    });
  }
}

const NEGATIVE_SIGNALS = [
  "couldn't find", 'could not find', 'no information', 'not appear', "don't have",
  'do not have', 'unable to find', 'no specific', 'not well-known', 'no online presence',
  'no results', 'not recommended', 'not listed', 'i cannot find',
];
const POSITIVE_SIGNALS = [
  'recommended', 'well-known', 'popular', 'highly rated', 'appears in', 'positive reviews',
  'reputable', 'established', 'frequently mentioned', 'top choice', 'leading',
];

/**
 * Clean a Perplexity reply into a response excerpt for the report card:
 * drop the COMPETITORS line, strip markdown/citations, collapse whitespace.
 * Returns the full prose (the report truncates it to a sentence boundary).
 */
function perplexityContext(text) {
  const withoutList = String(text || '').replace(/COMPETITORS:.*$/ims, '');
  return stripMarkdown(withoutList).replace(/\s+/g, ' ').trim();
}

/**
 * Interpret an UNBRANDED Perplexity reply (live web search). Prose, not
 * JSON — infer a STRICT discovery score from whether the business name
 * appears (and how prominently) and parse the trailing COMPETITORS list,
 * filtering to businesses explicitly tied to the location.
 */
function interpretPerplexityUnbranded(text, businessName, location) {
  const lower = (text || '').toLowerCase();
  const name = (businessName || '').toLowerCase();
  const nameAppears = name.length > 1 && lower.includes(name);
  const isNegative = NEGATIVE_SIGNALS.some((s) => lower.includes(s));
  const positiveCount = POSITIVE_SIGNALS.filter((s) => lower.includes(s)).length;

  // Is the business named right at the top of the answer (the primary pick)?
  const firstSentence = (lower.split(/(?<=[.!?])\s+/)[0] || '');
  const isPrimary = nameAppears && name && firstSentence.includes(name);

  let score;
  let found = false;
  let confidence = 'low';
  if (!nameAppears) {
    // Business name does not appear in the live results — score 0-15.
    score = isNegative ? 6 : 12;
    confidence = isNegative ? 'high' : 'low';
  } else if (isPrimary) {
    // Primary recommendation — 70+.
    score = Math.min(100, 72 + positiveCount * 7);
    found = true;
    confidence = positiveCount >= 2 ? 'high' : 'medium';
  } else {
    // Appears once, alongside others — 30-50.
    score = Math.min(50, 30 + positiveCount * 6);
    found = true;
    confidence = 'medium';
  }

  // Parse the trailing "COMPETITORS: ..." line and filter strictly.
  let competitors = [];
  const m = String(text || '').match(/COMPETITORS:\s*(.+)$/im);
  if (m && m[1]) {
    // Location tokens (words >2 chars) used to require explicit local context.
    const locTokens = (location || '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((t) => t.length > 2);
    const seen = new Set();
    for (const entry of m[1].split(/[;\n]/)) {
      const clean = stripMarkdown(entry).trim();
      if (!clean) continue;
      // Name is the part before a dash/colon/pipe separator.
      const cleanName = clean
        .split(/\s+[—–\-:|(]\s*/)[0]
        .replace(/[.)]+$/, '')
        .trim();
      const key = cleanName.toLowerCase();
      if (!cleanName || cleanName.length > 60 || key === name) continue;
      // Strict: with a location, the entry must explicitly reference it.
      if (location && locTokens.length) {
        const hasLoc = locTokens.some((t) => clean.toLowerCase().includes(t));
        if (!hasLoc) continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      competitors.push(cleanName);
    }
    competitors = competitors.slice(0, 8);
  }

  return {
    found,
    confidence,
    mentions: nameAppears ? [businessName] : [],
    context: perplexityContext(text),
    score: clampScore(score),
    competitors,
  };
}

/** POST a single prompt to OpenAI (JSON mode) and return its text. Throws on error. */
async function callOpenAI(env, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function queryOpenAI(env, input) {
  // ChatGPT = BRAND RECOGNITION only. Branded queries against training-data
  // awareness; it does not perform live discovery.
  try {
    const text = await callOpenAI(env, brandedPrompt(input));
    return buildBrandResult(normaliseResult(extractJson(text)));
  } catch (err) {
    console.error('OpenAI query failed:', err);
    return buildBrandResult(normaliseResult(null));
  }
}

/**
 * Extract 3–5 specific service keywords describing what the business does,
 * using a fast Claude Haiku call against the page metadata. These drive the
 * service-specific search queries every model is then tested against.
 * Returns [] on any failure — callers fall back to a generic check.
 */
async function extractServiceKeywords(env, { businessName, pageTitle, metaDescription, headingText, location }) {
  try {
    const prompt =
      `Based on this website information, extract 3 to 5 specific service keywords or phrases that describe ` +
      `what this business does. Return as a JSON array of strings. Only return the JSON array, nothing else.\n` +
      `Business name: ${businessName || 'unknown'}\n` +
      `Page title: ${pageTitle || 'unknown'}\n` +
      `Meta description: ${metaDescription || 'unknown'}\n` +
      `Page heading: ${headingText || 'unknown'}\n` +
      `Location: ${location || 'not specified'}\n` +
      `Example output: ["web design agency", "branding studio", "digital marketing", "WordPress development"]`;

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
    const arr = extractJsonArray(text);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean)
      .slice(0, 5);
  } catch (err) {
    console.error('Keyword extraction failed:', err);
    return [];
  }
}

async function generateRecommendations(env, input, scores) {
  const { businessName, location, serviceKeywords } = input;
  const { claudeScore, perplexityScore, openaiScore, overallScore, discoveryScore, brandScore, competitors } = scores;
  const services = (serviceKeywords || []).filter(Boolean);
  const fallback = defaultRecommendations();
  try {
    const serviceClause =
      services.length > 0
        ? `This business offers: ${services.join(', ')}${locationClause(location)}. ` +
          `Make every recommendation specific to this type of business and these services — ` +
          `not generic SEO advice. `
        : '';
    const competitorClause =
      competitors && competitors.length
        ? `When customers search WITHOUT the business name, these competitors appear instead: ` +
          `${competitors.slice(0, 8).join(', ')}. `
        : '';
    const prompt =
      `Based on this AI visibility data for ${businessName}: ` +
      `overall ${overallScore}/100, made up of a DISCOVERY score of ${discoveryScore}/100 ` +
      `(unbranded category searches, weighted 70%) and a BRAND score of ${brandScore}/100 ` +
      `(searches by name, weighted 30%). ` +
      `Per platform — Claude ${claudeScore}/100, Perplexity ${perplexityScore}/100, OpenAI ${openaiScore}/100. ` +
      serviceClause +
      competitorClause +
      `The critical commercial gap is the DISCOVERY score: this business is largely invisible when customers ` +
      `search for its service category without knowing its name. Generate exactly 5 specific, actionable ` +
      `recommendations that focus FIRST on how to start appearing in these unbranded category and location ` +
      `searches (not just searches for the business by name) — e.g. earning the third-party citations, reviews, ` +
      `directory listings and category-page authority that AI systems draw on when recommending a provider. ` +
      `Return as JSON array of objects with fields: title (string), description (string), ` +
      `priority ('high'|'medium'|'low'), effort ('quick'|'medium'|'significant').`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1536,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic recommendations ${res.status}`);
    const data = await res.json();
    const text = data?.content?.map((b) => b.text).join('') || '';
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
        'Publish pages that directly answer the category searches customers actually use — e.g. "[service] in [town]" — with clear evidence, FAQs and structured content AI systems can extract and cite when recommending a provider.',
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
  if (score < 40) return '#EF4444';
  if (score <= 70) return '#F59E0B';
  return '#0C7B82';
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
                <p style="margin:16px 0 0;">Your free AI Visibility Report for <strong>${businessName}</strong> is ready.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FC;border:1px solid #E4E8EF;border-radius:12px;">
                  <tr>
                    <td style="padding:24px;text-align:center;">
                      <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;font-family:Helvetica,Arial,sans-serif;">Your AI Visibility Score</div>
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
                <p style="margin:0;">We analysed ${businessName} across Claude, Perplexity, and ChatGPT to measure your presence in AI search results for the specific services you offer. Your report includes visibility scores, a breakdown by platform, the exact searches we tested, and five specific recommendations to improve.</p>
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
        subject: `Your AI Visibility Report for ${businessName} is Ready`,
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

  // Business name and sector are no longer collected from the form — they
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

  /* Step 1.5 - infer the business from the site's own page content.
     The meta title becomes the business name; the meta description, the
     og:description fallback, and the first H1 give us the raw material for
     service-keyword extraction. Falls back to the hostname if the fetch
     fails. */
  const meta = await fetchSiteMeta(websiteUrl);
  const pageTitle = meta.title || '';
  const metaDescription = meta.description || '';
  const headingText = meta.heading || '';
  const businessName =
    cleanBusinessName(meta.title) || hostnameFromUrl(websiteUrl) || 'this business';
  const businessContext = [pageTitle, metaDescription, headingText]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 600);

  /* Step 1.6 - extract the specific services this business offers, then
     build BOTH query sets:
       Set 1 — unbranded discovery queries (no business name) → Perplexity
       Set 2 — branded queries (include the name) → Claude + ChatGPT */
  const serviceKeywords = await extractServiceKeywords(env, {
    businessName,
    pageTitle,
    metaDescription,
    headingText,
    location,
  });
  const unbrandedQueries = buildUnbrandedQueries(serviceKeywords, location);
  const brandedQueries = buildBrandedQueries(businessName, serviceKeywords, location);
  // Combined list kept for the email + backward-compatible `queries` field.
  const queries = [...unbrandedQueries, ...brandedQueries];

  const input = {
    businessName,
    websiteUrl,
    businessContext,
    location,
    serviceKeywords,
    unbrandedQueries,
    brandedQueries,
    queries,
  };

  /* Steps 2–4 - query the three systems in parallel, each with its own job:
       Perplexity → live web-search DISCOVERY (unbranded queries only)
       Claude     → BRAND RECOGNITION (branded queries only)
       ChatGPT    → BRAND RECOGNITION (branded queries only) */
  const [claudeResult, perplexityResult, openaiResult] = await Promise.all([
    queryClaude(env, input),
    queryPerplexity(env, input),
    queryOpenAI(env, input),
  ]);

  /* Stamp the relevant query list onto each result so the report and email
     show exactly what was checked. Perplexity ran the discovery queries;
     Claude and ChatGPT ran the branded queries. */
  perplexityResult.queriesChecked = unbrandedQueries;
  perplexityResult.unbrandedQueriesChecked = unbrandedQueries;
  for (const r of [claudeResult, openaiResult]) {
    r.queriesChecked = brandedQueries;
    r.brandedQueriesChecked = brandedQueries;
  }

  /* Competitors come ONLY from Perplexity — its live search results are the
     most accurate, current source. */
  const competitors = aggregateCompetitors([perplexityResult], businessName);

  /* Step 5 - scores. New honest methodology:
       Overall = Perplexity discovery (60%) + Claude brand (20%) + ChatGPT brand (20%).
     Discovery is Perplexity's live-search score; brand is the average of the
     two training-data awareness scores (for display). */
  const round1 = (n) => Math.round(n * 10) / 10;
  const discoveryScore = clampScore(perplexityResult.discoveryScore);
  const brandScore = round1((claudeResult.brandScore + openaiResult.brandScore) / 2);
  const hasUnbranded = unbrandedQueries.length > 0;
  const overallScore = hasUnbranded
    ? round1(discoveryScore * 0.6 + claudeResult.brandScore * 0.2 + openaiResult.brandScore * 0.2)
    : brandScore;

  /* Step 6 - recommendations, focused on the unbranded discovery gap. */
  const recommendations = await generateRecommendations(env, input, {
    claudeScore: claudeResult.score,
    perplexityScore: perplexityResult.score,
    openaiScore: openaiResult.score,
    overallScore,
    discoveryScore,
    brandScore,
    competitors,
  });

  /* Step 7 - persist (30 day TTL). */
  const id = crypto.randomUUID();
  const report = {
    id,
    firstName,
    businessName,
    websiteUrl,
    location,
    businessContext,
    serviceKeywords,
    unbrandedQueries,
    brandedQueries,
    queries,
    email,
    overallScore,
    discoveryScore,
    brandScore,
    competitors,
    claudeResult,
    perplexityResult,
    openaiResult,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
  await env.REPORTS.put(`report:${id}`, JSON.stringify(report), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  /* Step 8 - email. */
  const reportUrl = `https://foundeverywhere.co.uk/report/${id}`;
  const emailPlatforms = [
    { name: 'Claude', result: claudeResult },
    { name: 'Perplexity', result: perplexityResult },
    { name: 'ChatGPT', result: openaiResult },
  ];
  await sendEmail(env, {
    firstName,
    businessName,
    email,
    overallScore,
    reportUrl,
    platforms: emailPlatforms,
  });

  /* Step 9 - respond. */
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
 * after the first separator (| - – — :) and cap at 50 chars.
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
 * { title, description, heading } with null fields on any failure —
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

/** Internal notification email — plain, scannable detail table. */
function buildContactNotificationHtml(d) {
  const rows = [
    ['Name', `${d.firstName} ${d.lastName}`.trim()],
    ['Email', d.email],
    ['Website', d.websiteUrl || '—'],
    ['How can we help', d.helpWith || '—'],
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

/** Confirmation email to the submitter — branded, matches the report email. */
function buildContactConfirmationHtml(d) {
  const summary = [
    ['Name', `${d.firstName} ${d.lastName}`.trim()],
    ['Email', d.email],
    ['Website', d.websiteUrl || '—'],
    ['How can we help', d.helpWith || '—'],
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
                Found Everywhere &mdash; <a href="https://foundeverywhere.co.uk" style="color:#94A3B8;">foundeverywhere.co.uk</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Fire one Resend email; never throws — returns true/false. */
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
