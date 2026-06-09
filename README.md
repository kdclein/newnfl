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

## Notes

- The email form is **front-end only** — it validates and stores entries in
  `localStorage`. Wire the submit handler in `script.js` to a real backend
  (Supabase, a form service, or an API endpoint) when you're ready to
  collect a live waitlist.
- Disclaimer in the footer: informational/analytical use only — not financial
  or betting advice.
