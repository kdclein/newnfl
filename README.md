# NEWNFL — Numbers, Fundamentals & Logic

> **A new way to read the numbers.**

The landing page for **NEWNFL**, a sports analytics platform built on one
principle: **show the work — every score must be decomposable.**

- **Wordmark:** `NEWNFL` — *NEW* reads as the word; *NFL* carries the acronym.
- **Expansion:** **N**umbers, **F**undamentals & **L**ogic.
- **Numbers** — the raw, auditable data.
- **Fundamentals** — Quality × Value.
- **Logic** — regime-aware reasoning that produces **BUY / WATCH / AVOID / SELL**.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The single-page site (semantic, accessible markup). |
| `styles.css` | All styling — dark, analytics-forward theme. No framework. |
| `script.js` | Footer year, score count-up animation, email capture. |
| `favicon.svg` | Brand favicon. |

No build step and no dependencies — it's plain HTML/CSS/JS.

## Preview locally

Open `index.html` directly in a browser, or serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to your GoDaddy domain (newnfl)

These are static files, so any host works. Two common GoDaddy paths:

1. **GoDaddy cPanel / Web Hosting** — upload `index.html`, `styles.css`,
   `script.js`, and `favicon.svg` to the `public_html` folder via the
   File Manager or FTP. The site is live at your domain immediately.
2. **GoDaddy domain + external host (recommended for static sites)** —
   host the files on a static host (Netlify, Cloudflare Pages, GitHub Pages,
   Vercel) and point your GoDaddy DNS at it:
   - In GoDaddy → **Domains → DNS**, add the records your host gives you
     (typically a `CNAME` for `www` and an `A`/`ALIAS` for the apex).

## Waitlist (Supabase)

The "Request access" form writes to a Supabase Postgres table.

- **Project:** `newnfl` (`vhnbugglrpxwuzjfuzph`), region `us-east-2`.
- **Table:** `public.waitlist` (`email`, `source`, `user_agent`, `created_at`).
- **Security:** Row Level Security is **on**. The public (publishable) key can
  only **insert** rows that look like genuine landing-page signups; it **cannot
  read, update, or delete** the list. View signups from the Supabase dashboard
  (Table editor) or with the service-role key.
- **Config:** `SUPABASE_URL` and `SUPABASE_KEY` live at the top of `script.js`.
  The key is the **publishable** key and is safe to ship in the browser — it's
  protected by RLS. Never put the `service_role` key in client code.
- **Fallback:** if the network call fails, the email is still saved to
  `localStorage` so intent isn't lost, and the user sees a success message.

Export current signups (dashboard → SQL editor, or service role):

```sql
select email, source, created_at from public.waitlist order by created_at desc;
```

## Notes

- Disclaimer in the footer: informational/analytical use only — not financial
  or betting advice.
