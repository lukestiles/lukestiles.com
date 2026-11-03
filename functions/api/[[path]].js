// Cloudflare Pages Function: backend for the TALK section on the homepage.
//
//   GET  /api/config         -> whether the voice agent is configured, plus public settings
//   POST /api/talk           -> Turnstile check, then a short-lived ElevenLabs conversation token
//   POST /api/call/start     -> Turnstile check, then text a verification code to a US number
//   POST /api/call/confirm   -> check the code, then have the agent call that number
//
// Secrets live in Cloudflare Pages environment variables (see README). Nothing here
// is reachable from the browser except these four routes.

const ELEVENLABS_API = "https://api.elevenlabs.io";
const TWILIO_VERIFY_API = "https://verify.twilio.com/v2";
const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Shown next to the checkbox on the form; recorded with every call.
export const CONSENT_TEXT =
  "I agree to receive one automated call from Luke's AI voice agent at this number, which I asked for. " +
  "The call may be recorded and transcribed.";

// +1 area codes that are not in the US: Canada, the Caribbean and Atlantic islands,
// plus non-geographic and premium codes. Rejected to block SMS-pumping and toll fraud.
// Twilio geo permissions (US only) are the backstop.
const NON_US_NPA = new Set(("204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 387 403 416 418 428 " +
  "431 437 438 450 460 468 474 506 514 519 537 548 579 581 584 587 604 613 622 633 639 644 647 655 672 677 " +
  "683 688 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942 " +
  "242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876 " +
  "500 521 522 523 524 525 526 527 528 529 533 544 566 577 588 600 700 710 800 833 844 855 866 877 888 900").split(" "));

const REQUIRED_ENV = [
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_WEB_AGENT_ID",
  "ELEVENLABS_PHONE_AGENT_ID",
  "ELEVENLABS_PHONE_NUMBER_ID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_VERIFY_SERVICE_SID",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
];

export async function onRequest({ request, env, params }) {
  const route = (params.path || []).join("/");
  try {
    if (route === "config" && request.method === "GET") return config(env);
    if (!isConfigured(env)) return json({ error: "Not available yet." }, 503);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (!sameOrigin(request)) return json({ error: "Forbidden." }, 403);

    const body = await request.json().catch(() => ({}));
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const host = new URL(request.url).hostname;
    if (route === "talk") return talk(env, body, ip, host);
    if (route === "call/start") return callStart(env, body, ip, host);
    if (route === "call/confirm") return callConfirm(env, body, ip);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong. Try again, or email luke [at] lukestiles [dot] com." }, 500);
  }
}

function config(env) {
  return json({
    enabled: isConfigured(env),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
    phoneNumber: env.PUBLIC_PHONE_NUMBER || null,
    consentText: CONSENT_TEXT,
  });
}

async function talk(env, body, ip, host) {
  if (!(await turnstileOk(env, body.turnstileToken, ip, host, "talk"))) return json({ error: "Verification failed. Refresh and try again." }, 403);
  const url = `${ELEVENLABS_API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(env.ELEVENLABS_WEB_AGENT_ID)}`;
  const res = await fetch(url, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
  if (!res.ok) {
    console.error("token", res.status, await res.text());
    return json({ error: "The agent is unavailable right now." }, 502);
  }
  const { token } = await res.json();
  return json({ token });
}

async function callStart(env, body, ip, host) {
  const form = cleanForm(body);
  if (form.error) return json({ error: form.error }, 400);
  if (body.consent !== true) return json({ error: "Please tick the consent box." }, 400);
  if (!(await turnstileOk(env, body.turnstileToken, ip, host, "call"))) return json({ error: "Verification failed. Refresh and try again." }, 403);

  const res = await twilio(env, "Verifications", { To: form.phone, Channel: "sms" });
  if (!res.ok) {
    console.error("verify start", res.status, await res.text());
    return json({ error: "Couldn't send a code to that number." }, 400);
  }
  return json({ ok: true });
}

async function callConfirm(env, body, ip) {
  const form = cleanForm(body);
  if (form.error) return json({ error: form.error }, 400);
  if (body.consent !== true) return json({ error: "Please tick the consent box." }, 400);
  const code = String(body.code || "").replace(/\D/g, "");
  if (code.length < 4 || code.length > 10) return json({ error: "Enter the code from the text." }, 400);

  const check = await twilio(env, "VerificationCheck", { To: form.phone, Code: code });
  const result = check.ok ? await check.json() : null;
  if (!result || result.status !== "approved") return json({ error: "That code didn't work. Try again." }, 400);

  const consentAt = new Date().toISOString();
  await logConsent(env, { phone: form.phone, consent_text: CONSENT_TEXT, consent_at: consentAt, ip, verify_sid: result.sid });

  const res = await fetch(`${ELEVENLABS_API}/v1/convai/twilio/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_PHONE_AGENT_ID,
      agent_phone_number_id: env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: form.phone,
      conversation_initiation_client_data: {
        dynamic_variables: {
          caller_name: form.name,
          caller_email: form.email,
          caller_topic: form.topic,
          consent_text: CONSENT_TEXT,
          consent_at: consentAt,
        },
      },
    }),
  });
  if (!res.ok) {
    console.error("outbound", res.status, await res.text());
    return json({ error: "Couldn't place the call right now." }, 502);
  }
  return json({ ok: true });
}

// Normalize and bound everything a visitor typed. Values reach the agent only as
// context for the LLM, never as words it speaks verbatim.
function cleanForm(body) {
  const name = String(body.name || "").replace(/[^\p{L}\p{M} .'-]/gu, "").trim().slice(0, 40);
  const email = String(body.email || "").trim().slice(0, 120);
  const topic = String(body.topic || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  const digits = String(body.phone || "").replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!name) return { error: "Please add your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Please add a valid email." };
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national) || NON_US_NPA.has(national.slice(0, 3))) {
    return { error: "Please use a US phone number." };
  }
  return { name, email, topic, phone: `+1${national}` };
}

// Valid only if Turnstile passed, on this site, for this action.
async function turnstileOk(env, token, ip, host, action) {
  if (!token) return false;
  const res = await fetch(TURNSTILE_VERIFY, {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
  });
  const out = await res.json().catch(() => ({}));
  return out.success === true && out.hostname === host && out.action === action;
}

// Durable TCPA consent record, if a KV namespace is bound as CONSENT_LOG. Kept 4 years.
async function logConsent(env, record) {
  console.log("consent", JSON.stringify(record));
  if (!env.CONSENT_LOG) return;
  const key = `consent:${record.consent_at}:${record.phone}`;
  await env.CONSENT_LOG.put(key, JSON.stringify(record), { expirationTtl: 4 * 365 * 24 * 3600 });
}

function twilio(env, path, fields) {
  const auth = btoa(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`);
  return fetch(`${TWILIO_VERIFY_API}/Services/${env.TWILIO_VERIFY_SERVICE_SID}/${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

function isConfigured(env) {
  return REQUIRED_ENV.every((k) => env[k]);
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
