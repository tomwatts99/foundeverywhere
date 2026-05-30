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
  'You are an AI visibility analyst. You will be given a business name, website, location, and a short description of what the business does (taken from its own website). Your job is to determine whether this business would appear in AI-generated search results. Respond only with valid JSON matching the schema provided.';

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
    context: typeof parsed?.context === 'string' ? parsed.context : '',
    score,
  };
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function locationClause(location) {
  return location ? ` in ${location}` : '';
}

function userPrompt({ businessName, websiteUrl, businessContext, location }) {
  const ctx = businessContext
    ? `About the business (taken from its own website): ${businessContext}. `
    : '';
  return (
    `Analyse the AI search visibility for this business: ` +
    `Business name: ${businessName}, Website: ${websiteUrl}, Location: ${location || 'not specified'}. ` +
    ctx +
    `Based on your training data, would this business appear when someone asks an AI assistant ` +
    `to recommend this kind of business${locationClause(location)}? ` +
    `Return JSON with this exact schema: { found: boolean, confidence: 'high'|'medium'|'low', mentions: string[], context: string, score: number between 0 and 100 }`
  );
}

/* ------------------------------------------------------------------ */
/* Model calls - each returns a normalised result; never throws.       */
/* ------------------------------------------------------------------ */

async function queryClaude(env, input) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(input) }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const text = data?.content?.map((b) => b.text).join('') || '';
    return normaliseResult(extractJson(text));
  } catch (err) {
    console.error('Claude query failed:', err);
    return normaliseResult(null);
  }
}

async function queryPerplexity(env, input) {
  const { businessName, websiteUrl, businessContext, location } = input;
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: 'user',
            content:
              `Is ${businessName} (${websiteUrl}) a well-known or recommended business${locationClause(location)}? ` +
              (businessContext ? `Context about what they do, from their website: ${businessContext}. ` : '') +
              `Do they appear in search results or online recommendations? Give a brief factual answer.`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Perplexity ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return interpretPerplexity(text, businessName);
  } catch (err) {
    console.error('Perplexity query failed:', err);
    return { found: false, confidence: 'low', mentions: [], context: '', score: 0 };
  }
}

/**
 * Perplexity returns prose, not JSON. Infer a score from whether the
 * business name appears and whether the tone is positive or negative.
 */
function interpretPerplexity(text, businessName) {
  const lower = text.toLowerCase();
  const name = businessName.toLowerCase();
  const nameAppears =
    name.length > 1 && lower.includes(name);

  const negativeSignals = [
    "couldn't find",
    'could not find',
    'no information',
    'not appear',
    "don't have",
    'do not have',
    'unable to find',
    'no specific',
    'not well-known',
    'no online presence',
    'no results',
    'not recommended',
  ];
  const positiveSignals = [
    'recommended',
    'well-known',
    'popular',
    'highly rated',
    'appears in',
    'positive reviews',
    'reputable',
    'established',
    'frequently mentioned',
  ];

  const isNegative = negativeSignals.some((s) => lower.includes(s));
  const positiveCount = positiveSignals.filter((s) => lower.includes(s)).length;

  let score = 0;
  let found = false;
  let confidence = 'low';

  if (nameAppears && !isNegative) {
    found = true;
    score = Math.min(100, 45 + positiveCount * 12);
    confidence = positiveCount >= 2 ? 'high' : 'medium';
  } else if (nameAppears && isNegative) {
    found = false;
    score = 20;
    confidence = 'medium';
  } else {
    found = false;
    score = isNegative ? 5 : 15;
    confidence = isNegative ? 'high' : 'low';
  }

  // First two sentences as context.
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const context = sentences.slice(0, 2).join(' ');

  return {
    found,
    confidence,
    mentions: nameAppears ? [businessName] : [],
    context,
    score: clampScore(score),
  };
}

async function queryOpenAI(env, input) {
  try {
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
          { role: 'user', content: userPrompt(input) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return normaliseResult(extractJson(text));
  } catch (err) {
    console.error('OpenAI query failed:', err);
    return normaliseResult(null);
  }
}

async function generateRecommendations(env, input, scores) {
  const { businessName } = input;
  const { claudeScore, perplexityScore, openaiScore, overallScore } = scores;
  const fallback = defaultRecommendations();
  try {
    const prompt =
      `Based on this AI visibility data for ${businessName}: ` +
      `Claude score ${claudeScore}/100, Perplexity score ${perplexityScore}/100, ` +
      `OpenAI score ${openaiScore}/100, overall ${overallScore}/100. ` +
      `Generate exactly 5 specific, actionable recommendations to improve their AI visibility. ` +
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
      title: 'Implement comprehensive schema markup',
      description:
        'Add Organisation, WebSite, LocalBusiness, Service, and FAQPage schema across your site so AI systems can identify your business as a coherent entity.',
      priority: 'high',
      effort: 'medium',
    },
    {
      title: 'Add an llms.txt file to your domain root',
      description:
        'Publish a plain-text llms.txt describing your business and key pages. Several major AI systems already check for this file.',
      priority: 'high',
      effort: 'quick',
    },
    {
      title: 'Standardise your entity across the web',
      description:
        'Make your business name, address, and contact details identical on your website, Google Business Profile, and every directory you appear in.',
      priority: 'high',
      effort: 'medium',
    },
    {
      title: 'Restructure key pages to answer questions directly',
      description:
        'Add FAQ sections to service pages and open each section with a direct answer so AI systems can extract and cite your content.',
      priority: 'medium',
      effort: 'medium',
    },
    {
      title: 'Build authoritative third-party citations',
      description:
        'Get listed in relevant industry directories and seek coverage in local or trade press to strengthen the signals AI systems rely on.',
      priority: 'medium',
      effort: 'significant',
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

function buildEmailHtml({ firstName, businessName, overallScore, reportUrl }) {
  const colour = scoreColour(overallScore);
  const barPct = Math.max(2, Math.min(100, overallScore));
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#F7F9FC;font-family:Helvetica,Arial,sans-serif;color:#0D1321;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FC;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E4E8EF;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 8px;">
                <span style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:#0D1321;">Found</span><span style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:#0C7B82;">&nbsp;Everywhere</span>
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
            </tr>
            <tr>
              <td style="padding:24px 40px 0;font-size:15px;line-height:1.65;color:#475569;">
                <p style="margin:0;">We analysed ${businessName} across Claude, Perplexity, and ChatGPT to measure your presence in AI search results. Your report includes visibility scores, a breakdown by platform, and five specific recommendations to improve.</p>
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

async function sendEmail(env, { firstName, businessName, email, overallScore, reportUrl }) {
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
        html: buildEmailHtml({ firstName, businessName, overallScore, reportUrl }),
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
     The meta title becomes the business name; the meta description (plus
     title) becomes the context handed to every AI prompt in place of a
     sector dropdown. Falls back to the hostname if the fetch fails. */
  const meta = await fetchSiteMeta(websiteUrl);
  const businessName = meta.title || hostnameFromUrl(websiteUrl) || 'this business';
  const businessContext = [meta.title, meta.description]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 600);

  const input = { businessName, websiteUrl, businessContext, location };

  /* Steps 2–4 - query the three systems in parallel. */
  const [claudeResult, perplexityResult, openaiResult] = await Promise.all([
    queryClaude(env, input),
    queryPerplexity(env, input),
    queryOpenAI(env, input),
  ]);

  /* Step 5 - overall score (average, 1 dp). */
  const overallScore =
    Math.round(
      ((claudeResult.score + perplexityResult.score + openaiResult.score) / 3) * 10,
    ) / 10;

  /* Step 6 - recommendations. */
  const recommendations = await generateRecommendations(env, input, {
    claudeScore: claudeResult.score,
    perplexityScore: perplexityResult.score,
    openaiScore: openaiResult.score,
    overallScore,
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
    email,
    overallScore,
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
  await sendEmail(env, { firstName, businessName, email, overallScore, reportUrl });

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
  // Prefer og:description, then the standard meta description.
  const og =
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["']/i);
  if (og && og[1]) return decodeEntities(og[1]) || null;
  const desc =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  if (desc && desc[1]) return decodeEntities(desc[1]) || null;
  return null;
}

function hostnameFromUrl(rawUrl) {
  try {
    let target = String(rawUrl).trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    return new URL(target).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and pull its title + description. Returns
 * { title, description } with null fields on any failure — never throws.
 */
async function fetchSiteMeta(rawUrl) {
  const empty = { title: null, description: null };
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
    return { title: extractTitle(html), description: extractDescription(html) };
  } catch (err) {
    console.error('fetchSiteMeta failed:', err);
    return empty;
  }
}

async function handleFetchMeta(rawUrl, env) {
  const { title } = await fetchSiteMeta(rawUrl);
  return json({ title }, 200, env);
}

async function handleGetReport(id, env) {
  if (!id) return json({ success: false, message: 'Missing report id.' }, 400, env);
  const raw = await env.REPORTS.get(`report:${id}`);
  if (!raw) {
    return json({ success: false, message: 'Report not found.' }, 404, env);
  }
  return new Response(raw, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
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
      return handleGetReport(decodeURIComponent(reportMatch[1]), env);
    }

    if (url.pathname === '/api/fetch-meta' && request.method === 'GET') {
      return handleFetchMeta(url.searchParams.get('url'), env);
    }

    return json({ success: false, message: 'Not found.' }, 404, env);
  },
};
