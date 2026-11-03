# lukestiles.com

The personal homepage for [Luke Stiles](https://lukestiles.com).

## Local preview

This is a dependency-free static site. Open `index.html` in a browser to preview it locally.

## Deployment

Cloudflare Pages is connected directly to this GitHub repository:

- pushes to `main` deploy to production at `https://lukestiles.com`
- pull requests receive Cloudflare Pages preview deployments
- `https://www.lukestiles.com` permanently redirects to the canonical apex domain

## TALK: the AI voice agent

The TALK section lets visitors talk with an ElevenLabs voice agent in Luke's cloned voice, in the browser or by asking it to call them. The agent itself (prompt, knowledge, guardrails, setup runbook) lives in the `personal-context` repo under `site-agent/`.

- `talk.js` runs the section in the browser.
- `functions/api/[[path]].js` is a Cloudflare Pages Function with four routes: `GET /api/config`, `POST /api/talk`, `POST /api/call/start` and `POST /api/call/confirm`.

The section stays hidden until all of these are set in Cloudflare Pages (Settings > Environment variables, as encrypted secrets except the site key):

| Variable | From |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs. Best as a restricted key limited to Agents |
| `ELEVENLABS_AGENT_ID` | `site-agent/agents.json` after the agent is created |
| `ELEVENLABS_PHONE_NUMBER_ID` | ElevenLabs Phone Numbers, after importing the Twilio number |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | Twilio API key |
| `TWILIO_VERIFY_SERVICE_SID` | Twilio Verify service, for the text codes |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile widget for lukestiles.com and the Pages preview domain |
| `PUBLIC_PHONE_NUMBER` | Optional. The agent's number, shown as "or call …" |

Preview locally with `npx wrangler pages dev .` and a `.dev.vars` file holding the same variables. `.dev.vars` must never be committed.
