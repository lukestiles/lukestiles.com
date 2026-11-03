// TALK section: browser conversations and "call me" for the AI voice agent.
// Backend: functions/api/[[path]].js. The section stays hidden unless the backend is configured.

const SDK = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/+esm";
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const $ = (id) => document.getElementById(id);
const status = (text) => { $("talk-status").textContent = text; };
const track = (event, props) => { try { window.posthog?.capture(event, props); } catch {} };

let config = null;
let conversation = null;

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "Something went wrong.");
  return out;
}

// Cloudflare Turnstile, rendered only when needed; usually invisible.
let turnstileReady = null;
function turnstileToken() {
  turnstileReady ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TURNSTILE; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("Verification didn't load."));
    document.head.appendChild(s);
  });
  return turnstileReady.then(() => new Promise((resolve, reject) => {
    const box = $("turnstile");
    box.replaceChildren();
    window.turnstile.render(box, {
      sitekey: config.turnstileSiteKey,
      appearance: "interaction-only",
      callback: resolve,
      "error-callback": () => reject(new Error("Verification failed. Refresh and try again.")),
    });
  }));
}

async function startTalk() {
  const button = $("talk-start");
  if (conversation) { await conversation.endSession(); return; }
  button.disabled = true;
  try {
    status("This uses your microphone so you can talk with the agent. Allow access to start.");
    await navigator.mediaDevices.getUserMedia({ audio: true });
    status("connecting…");
    const [{ Conversation }, captcha] = await Promise.all([import(SDK), turnstileToken()]);
    const { token } = await post("/api/talk", { turnstileToken: captcha });
    conversation = await Conversation.startSession({
      conversationToken: token,
      connectionType: "webrtc",
      dynamicVariables: { entry_point: "web" },
      onConnect: () => { button.textContent = "end conversation"; button.disabled = false; track("talk_started"); },
      onModeChange: ({ mode }) => status(mode === "speaking" ? "speaking…" : "listening…"),
      onDisconnect: () => {
        conversation = null;
        button.textContent = "talk in the browser"; button.disabled = false;
        status("Conversation ended.");
        track("talk_ended");
      },
      onError: (message) => status(typeof message === "string" ? message : "Something went wrong."),
    });
  } catch (err) {
    conversation = null;
    button.disabled = false;
    status(err?.name === "NotAllowedError" ? "Microphone access is needed to talk." : err.message);
  }
}

function openCallForm() {
  $("call-form").hidden = false;
  $("call-open").disabled = true;
  status("");
  $("call-form").elements.name.focus();
}

let codeSent = false;
async function submitCall(event) {
  event.preventDefault();
  const form = $("call-form");
  const f = Object.fromEntries(new FormData(form));
  const fields = { name: f.name, phone: f.phone, email: f.email, topic: f.topic };
  const submit = $("call-submit");
  submit.disabled = true;
  try {
    if (!codeSent) {
      status("sending a code…");
      const captcha = await turnstileToken();
      await post("/api/call/start", { ...fields, consent: form.elements.consent.checked, turnstileToken: captcha });
      codeSent = true;
      $("code-row").hidden = false;
      form.elements.code.required = true;
      form.elements.code.focus();
      submit.textContent = "call me";
      status("Code sent. Enter it above.");
      track("call_code_sent");
    } else {
      status("placing the call…");
      await post("/api/call/confirm", { ...fields, code: f.code });
      form.hidden = true;
      status("Calling you now. If you miss it, come back and try again.");
      track("call_placed");
    }
  } catch (err) {
    status(err.message);
  } finally {
    submit.disabled = false;
  }
}

async function init() {
  try {
    const res = await fetch("/api/config");
    config = res.ok ? await res.json() : null;
  } catch { config = null; }
  if (!config?.enabled) return;

  $("consent-text").textContent = config.consentText;
  if (config.phoneNumber) {
    const phone = $("talk-phone");
    phone.hidden = false;
    phone.innerHTML = `or call <a href="tel:${config.phoneNumber.replace(/[^+\d]/g, "")}"></a>`;
    phone.querySelector("a").textContent = config.phoneNumber;
  }
  $("talk-start").addEventListener("click", startTalk);
  $("call-open").addEventListener("click", openCallForm);
  $("call-form").addEventListener("submit", submitCall);
  $("talk").hidden = false;
}

init();
