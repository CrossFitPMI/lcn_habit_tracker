/*
  Lean Comp Nutrition — AI coach backend proxy (Cloudflare Worker)
  ------------------------------------------------------------------
  This is the piece that makes the coach safe to put on a public site.
  It sits between your GitHub Pages front-end and the Anthropic API, and does
  the four things that raw public JavaScript can't do safely:

    1. Holds your API key server-side (never exposed in the browser).
    2. Enforces a per-client daily message cap (your cost ceiling + upsell hook).
    3. Routes cheap chat turns to Haiku, the summary to Sonnet, and caches the
       system prompt so you're not paying full price for the same context
       on every single turn.
    4. Writes each client's weekly review (mode 'weekly') — outside the daily
       chat cap, with its own small weekly limit, and with the Free/Pro split
       enforced here.
    5. Listens for Stripe payment events at /stripe-webhook and automatically
       grants/revokes Pro access — no manual list editing needed once this
       is wired up.

  STRIPE SETUP (one-time, ~10 min, all clicking, no code):
    - In Stripe: create the €20/month product, get its Payment Link, and under
      that link's "After payment" settings, set the redirect to your app's URL
      with ?upgraded=1 on the end (e.g. https://crossfitpmi.github.io/lcn_habit_tracker/?upgraded=1).
    - Paste that Payment Link into STRIPE_PAYMENT_LINK in the front-end HTML file.
    - In Stripe: Developers → Webhooks → Add endpoint. URL is this Worker's
      address + /stripe-webhook (e.g. https://lean-comp-coach.yoursubdomain.workers.dev/stripe-webhook).
      Subscribe it to: checkout.session.completed, customer.subscription.deleted.
    - Stripe shows you a signing secret (starts "whsec_...") — copy it.
    - In Cloudflare: this Worker → Settings → Variables and Secrets → Add.
      Name it STRIPE_WEBHOOK_SECRET, paste the value, save as Secret. Deploy.
*/

const FREE_DAILY_CAP = 5;      // messages/day for free clients (matches the upsell model)
const PRO_DAILY_CAP  = 100;    // effectively "unlimited" for a paying client, but still a ceiling
/* Origins allowed to call this Worker. The github.io address stays on the
   list so anyone who installed the app before the domain move keeps working —
   drop it once you're sure nobody's still on the old URL. */
const ALLOWED_ORIGINS = [
  'https://app.leancompnutrition.com',
  'https://crossfitpmi.github.io',
];
/* Emails of clients who've paid for the add-on, granted by hand rather than
   through Stripe (e.g. a friend, a free trial). Real paying clients are
   tracked automatically in KV via the Stripe webhook below — this list is
   just a manual override on top of that. */
const PRO_CLIENTS = [
  'michealfitzpatrick@gmail.com',
];

const MODELS = {
  chat:     'claude-haiku-4-5-20251001',  // free-tier check-in turns — cheap
  chatPro:  'claude-sonnet-5',            // Pro check-in turns — noticeably sharper coaching
  summary:  'claude-sonnet-5',            // end-of-session summary — quality matters here
};

async function isPro(clientId, env) {
  const email = clientId.toLowerCase();
  if (PRO_CLIENTS.includes(email)) return true;
  return (await env.COACH_LIMITS.get('pro:' + email)) === 'true';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/stripe-webhook') return handleStripeWebhook(request, env);

    // Which origin is asking decides which origin we allow back. Kept as a
    // per-request local (not a shared variable) so two clients on different
    // domains hitting the Worker at the same moment can't cross wires.
    const origin = request.headers.get('Origin') || '';
    const cors = (res) => withCors(res, origin);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    // Tier lookup for the app on load. GET, so it must sit above the
    // POST-only guard below. No AI call, no cap consumption.
    if (request.method === 'GET' && url.searchParams.get('action') === 'tier') {
      const clientId = url.searchParams.get('clientId') || '';
      const tier = clientId && (await isPro(clientId, env)) ? 'pro' : 'free';
      return cors(json({ tier }));
    }
    if (request.method !== 'POST')    return cors(json({ error: 'POST only' }, 405));

    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: 'Bad JSON' }, 400)); }

    const { clientId, mode = 'chat', system, messages } = body;
    if (!clientId || !Array.isArray(messages)) {
      return cors(json({ error: 'Missing clientId or messages' }, 400));
    }
    // clientId is the client's email. Tier is decided here, server-side — from
    // Stripe-driven KV data plus the manual override list — never trust a tier
    // value if it ever came from the browser.
    const tier = (await isPro(clientId, env)) ? 'pro' : 'free';

    // ── Meal plans are Pro-only, enforced here (not just hidden in the UI) ──
    // The daily slot is NOT spent here — only after a valid plan comes back,
    // so a failed or malformed generation never costs the client an attempt.
    let mpKey = null;
    if (mode === 'mealplan') {
      if (tier !== 'pro') {
        return cors(json({ error: 'pro_required', message: 'Meal plans are part of Pro.' }, 403));
      }
      const today = new Date().toISOString().slice(0, 10);
      mpKey = `mp:${clientId}:${today}`;
      const mpUsed = parseInt(await env.COACH_LIMITS.get(mpKey) || '0', 10);
      if (mpUsed >= 3) {
        return cors(json({ error: 'cap_reached', message: "That's 3 meal plans today — tweak tomorrow if this one's not right." }, 429));
      }
    }

    // ── Weekly review: its own small limit, NOT the daily chat cap ────────
    // Up to 3 reviews per client per week (first go + a couple of retries).
    // Like meal plans, the slot is only spent once a valid review comes back.
    let wkKey = null;
    if (mode === 'weekly') {
      wkKey = `wk:${clientId}:${weekKey()}`;
      const wkUsed = parseInt(await env.COACH_LIMITS.get(wkKey) || '0', 10);
      if (wkUsed >= 3) {
        return cors(json({ error: 'cap_reached', message: "You've already had this week's review — your next one opens on Sunday." }, 429));
      }
    }

    // ── Per-client daily cap ──────────────────────────────────────────────
    // Summaries and weekly reviews don't count against the cap — only chat turns do.
    if (mode === 'chat') {
      const cap = tier === 'pro' ? PRO_DAILY_CAP : FREE_DAILY_CAP;
      const today = new Date().toISOString().slice(0, 10);
      const key = `${clientId}:${today}`;
      const used = parseInt(await env.COACH_LIMITS.get(key) || '0', 10);
      if (used >= cap) {
        // Usage stat: how often the free wall is actually being hit.
        // View these anytime in Cloudflare → Storage → KV → coach-limits
        // (keys starting "stats:"). They self-expire after ~90 days.
        await bumpStat(env, `stats:${today}:cap_hits`);
        return cors(json({
          error: 'cap_reached',
          message: tier === 'pro'
            ? "You've hit today's limit — back tomorrow."
            : "That's your free check-ins for today. Upgrade for daily coaching.",
          used, cap,
        }, 429));
      }
      // Counter expires 48h out so it self-cleans; increment before the call.
      await env.COACH_LIMITS.put(key, String(used + 1), { expirationTtl: 172800 });
      await bumpStat(env, `stats:${today}:messages`);
      await bumpStat(env, `stats:${today}:messages_${tier}`);
    }

    // ── Prompt caching ────────────────────────────────────────────────────
    // The system prompt (your coach persona + this client's data block) is
    // identical across every turn in a session, so we mark it cacheable.
    // Cache reads are ~90% cheaper than fresh input — big saving on a chat loop.
    // Appended server-side so it applies to every client without touching the
    // front-end prompt. Constant text, so the prompt cache still holds.
    const CHAT_BREVITY = `

REPLY LENGTH AND FORMAT:
- Keep replies under 90 words.
- Plain text only. No markdown, no asterisks, no bold, no numbered or bulleted lists.
- One idea per message. If there is more worth saying, offer it in a short question and wait.`;

    const systemText = (system && mode === 'chat') ? system + CHAT_BREVITY
                     : mode === 'weekly' ? (system || '') + (tier === 'pro' ? WEEKLY_FORMAT_PRO : WEEKLY_FORMAT_FREE)
                     : system;
    const systemBlocks = systemText
      ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const payload = {
      model: mode === 'summary' ? MODELS.summary
           : mode === 'mealplan' ? MODELS.summary
           : mode === 'weekly' ? (tier === 'pro' ? MODELS.summary : MODELS.chat)
           : (tier === 'pro' ? MODELS.chatPro : MODELS.chat),
      max_tokens: mode === 'summary' ? 500 : mode === 'mealplan' ? 16000
                : mode === 'weekly' ? (tier === 'pro' ? 1000 : 500) : 600,
      // A weekly review is always the same single request, whatever the
      // browser sent — so this mode can't be used as uncapped free chat.
      messages: mode === 'weekly' ? [{ role: 'user', content: 'Write my weekly review now.' }] : messages,
    };
    if (systemBlocks) payload.system = systemBlocks;

    // ── Call Anthropic ────────────────────────────────────────────────────
    let apiRes;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
    } catch {
      return cors(json({ error: 'upstream_unreachable' }, 502));
    }

    const data = await apiRes.json();
    if (!apiRes.ok) return cors(json({ error: 'upstream_error', detail: data }, apiRes.status));

    let text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    // If we still hit the ceiling, trim back to the last complete sentence.
    // Chat only — summary and mealplan are JSON and must not be cut.
    if (mode === 'chat' && data.stop_reason === 'max_tokens' && !/[.!?]$/.test(text)) {
      const cut = Math.max(
        text.lastIndexOf('. '), text.lastIndexOf('.\n'),
        text.lastIndexOf('! '), text.lastIndexOf('!\n'),
        text.lastIndexOf('? '), text.lastIndexOf('?\n'),
      );
      if (cut > 0) text = text.slice(0, cut + 1);
    }

    // ── Meal plan: validate BEFORE spending a daily slot ──────────────────
    // The browser has to parse this as JSON to render it. If it wouldn't
    // parse, the client sees an error and would otherwise have lost an
    // attempt for nothing — so check it here and only count real successes.
    if (mode === 'mealplan') {
      let ok = false;
      try {
        const plan = JSON.parse(text.replace(/```json|```/g, '').trim());
        ok = Array.isArray(plan.days) && plan.days.length > 0;
      } catch { ok = false; }
      if (!ok) {
        // Ran out of room mid-plan — say so plainly rather than "try again",
        // because retrying the same oversized request will just fail again.
        const truncated = data.stop_reason === 'max_tokens';
        return cors(json({
          error: 'bad_plan',
          message: truncated
            ? "That plan was too big to finish. Try fewer days, or drop back to fewer meals per day — it won't count against today's plans."
            : "That one didn't come out right — hit generate again, it won't count against today's plans.",
        }, 502));
      }
      const today = new Date().toISOString().slice(0, 10);
      const mpUsed = parseInt(await env.COACH_LIMITS.get(mpKey) || '0', 10);
      await env.COACH_LIMITS.put(mpKey, String(mpUsed + 1), { expirationTtl: 172800 });
      await bumpStat(env, `stats:${today}:mealplans`);
    }

    // Free-tier summaries only include the key insight — the action item and
    // pattern are Pro content, stripped HERE so they never reach a free
    // client's browser at all (not merely hidden in the UI).
    if (mode === 'summary' && tier === 'free') {
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        text = JSON.stringify({
          key_insight: parsed.key_insight || '',
          action_item: '',
          pattern_noticed: '',
        });
      } catch { /* if the model returned malformed JSON, pass through as-is */ }
    }

    // ── Weekly review: validate, keep only this tier's fields, then spend the slot ──
    // Free gets headline / went_well / focus. The Pro sections are dropped
    // HERE, so they never reach a free client's browser at all.
    if (mode === 'weekly') {
      let review = null;
      try { review = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { review = null; }
      if (!review || typeof review !== 'object' || !review.headline || !review.focus) {
        return cors(json({ error: 'bad_review', message: "Your review didn't come out right — try again, it won't count against this week." }, 502));
      }
      const fields = tier === 'pro'
        ? ['headline', 'week_on_week', 'went_well', 'to_work_on', 'focus', 'focus_why']
        : ['headline', 'went_well', 'focus'];
      const clean = {};
      fields.forEach(f => { if (review[f]) clean[f] = String(review[f]).slice(0, 700); });
      const today = new Date().toISOString().slice(0, 10);
      const wkUsed = parseInt(await env.COACH_LIMITS.get(wkKey) || '0', 10);
      await env.COACH_LIMITS.put(wkKey, String(wkUsed + 1), { expirationTtl: 1209600 }); // 14 days
      await bumpStat(env, `stats:${today}:weekly_${tier}`);
      return cors(json({ text: JSON.stringify(clean), review: clean, tier }));
    }

    return cors(json({ text, tier }));
  },
};

// ── Weekly review formats (appended to the app's data brief by tier) ───────
const WEEKLY_RULES = `

RULES FOR THE REVIEW:
- Use only the numbers and words given above. Never invent a figure.
- Speak to them directly ("you"). Warm, specific, practical. No emojis, no markdown inside the text.
- The focus must be ONE small, specific action they can do most days this week (not a vague goal like "eat better"). If last week's focus didn't go well, make this week's a smaller, easier version rather than piling on something new.
- Never comment on their body or appearance. Weight only as a trend over weeks, and only if it helps.
- Respond with ONLY raw JSON, no markdown fences, no preamble.`;

const WEEKLY_FORMAT_FREE = WEEKLY_RULES + `
Exact shape:
{"headline":"one short sentence summing up their week, max 14 words","went_well":"1-2 sentences on what genuinely went well, citing their numbers or their own words","focus":"their ONE focus for this week, max 15 words, phrased as an action"}`;

const WEEKLY_FORMAT_PRO = WEEKLY_RULES + `
Exact shape:
{"headline":"one short sentence summing up their week, max 14 words","week_on_week":"2-3 sentences comparing this week with last week using the figures given (score, habit rates, check-in ratings). If there is no last week, say what you'll be watching next week instead","went_well":"1-2 sentences on what genuinely went well, citing their numbers or their own words","to_work_on":"1-2 sentences on the clearest thing holding them back, linked to what they said got in the way and to the data","focus":"their ONE focus for this week, max 15 words, phrased as an action","focus_why":"one sentence on why this focus, tied to their data"}`;

/* The date of this week's Sunday (UTC). Check-ins run Sun–Tue, so Mon/Tue
   reviews belong to the Sunday just gone — same week as the app uses. */
function weekKey() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// ── Stripe webhook ─────────────────────────────────────────────────────────
// Stripe calls this directly (never the browser), so no CORS handling needed.
async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const sig = request.headers.get('Stripe-Signature');
  const rawBody = await request.text(); // must verify against the RAW body, not parsed JSON
  if (!sig || !(await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('Invalid signature', { status: 400 });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
    const customerId = session.customer;
    if (email) await env.COACH_LIMITS.put('pro:' + email, 'true');
    // Remember which email this Stripe customer ID belongs to, so a future
    // cancellation event (which only carries the ID, not the email) can find
    // the right person to revoke — without needing a second Stripe API call.
    if (customerId && email) await env.COACH_LIMITS.put('customerEmail:' + customerId, email);
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    const email = customerId ? await env.COACH_LIMITS.get('customerEmail:' + customerId) : null;
    if (email) await env.COACH_LIMITS.delete('pro:' + email);
  }

  return new Response('ok', { status: 200 });
}

// Verifies the webhook genuinely came from Stripe, not someone faking a
// "payment succeeded" call. Stripe signs {timestamp}.{raw body} with your
// webhook secret using HMAC-SHA256 — this recomputes that and compares it.
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => {
    const [k, v] = p.split('=');
    return [k, v];
  }));
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === parts.v1;
}

// Simple daily counters for product visibility (messages sent, cap hits).
// Not perfectly atomic under heavy concurrency — fine at this scale, these
// are rough usage signals, not billing records.
async function bumpStat(env, key) {
  const n = parseInt(await env.COACH_LIMITS.get(key) || '0', 10);
  await env.COACH_LIMITS.put(key, String(n + 1), { expirationTtl: 7776000 }); // ~90 days
}

function withCors(res, origin) {
  // Access-Control-Allow-Origin can only ever carry ONE value — you can't
  // list two domains in it. So we echo back whichever allowed origin asked.
  // An origin that isn't on the list gets no header at all, and the browser
  // blocks it, which is exactly the lock this always had.
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.headers.set('Access-Control-Allow-Origin', origin);
  }
  // Without this, a cache can hand a response generated for one domain to the
  // other, complete with the wrong Allow-Origin header.
  res.headers.set('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}