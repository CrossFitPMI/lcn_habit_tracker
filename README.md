# lcn_habit_tracker
# Source copies — read this before editing

These files are **copies for version history**. They are not deployed from here.

| File | Where it actually runs | How to deploy |
|---|---|---|
| `index.html` | GitHub Pages (repo root) | this one IS live — it's served directly |
| `apps-script/Code.gs` | Apps Script `lean comp tracker` | paste into the editor, then Deploy → Manage deployments → New version |
| `apps-script/ClientApi.gs` | same project | same |
| `apps-script/WeeklyEmail.gs` | same project | same |
| `worker/index.js` | Cloudflare Worker `lean-comp-coach` | paste into the Cloudflare dashboard, Deploy |

**The trap:** editing a file in this folder changes nothing in production. Edit
in the real editor, then paste the result back here and commit, so the repo
stays the record of what's actually running. If you forget, the copies drift
and become worse than useless — misleading rather than merely absent.

## Why bother

Right now the Worker and the Apps Script exist only inside Google's and
Cloudflare's editors. There's no diff, no history, and no way to see what
changed when something breaks. Cloudflare keeps deployment versions and Apps
Script keeps a version list, but neither shows you *what changed between them*.

A copy in git gives you that, and gives a fresh conversation something to read
without you pasting files in one at a time.

## Still missing

- `apps-script/Code.gs` — paste your current `Code.gs` in and commit it
- `worker/index.js` — paste the Worker source in and commit it

I've left both out deliberately rather than committing a version I can't verify
is current. Copy them from the live editors.

## Secrets — do not commit

The repo is public. These live in Cloudflare Secrets and Apps Script Script
Properties and must never appear in a file here:

- `ANTHROPIC_API_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `COACH_PIN`
- `UNSUB_SECRET`

The Worker source references them as `env.X` — that's fine, the names aren't
secret. The values are.

Note the Apps Script web app URL and the Stripe payment/portal links are already
public (they're in `index.html`, which anyone can view-source), so committing
them changes nothing.
