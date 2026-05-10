# Journey Cost Calculator — Deployment Guide

A step-by-step guide to getting your app live. No coding experience required.
Estimated time: 30–45 minutes.

---

## What you'll need
- A free GitHub account (github.com)
- A free Render account (render.com)
- An Anthropic API key (console.anthropic.com)
- Your custom domain (optional, can add later)

---

## Step 1 — Get your Anthropic API key

1. Go to https://console.anthropic.com
2. Sign in or create an account
3. Click **Settings** → **API Keys** → **Create Key**
4. Copy the key and save it somewhere safe (you won't see it again)

### Set a spend limit (IMPORTANT — prevents surprise bills)
1. In the Anthropic console, go to **Settings** → **Limits**
2. Set a **Monthly spend limit** — £15–20 is plenty to start
3. This means the API will stop responding if you hit the limit rather than charging more

---

## Step 2 — Upload your code to GitHub

GitHub is where your code lives online — think of it as Google Drive for code.

1. Go to https://github.com and sign in
2. Click the **+** button (top right) → **New repository**
3. Name it `journey-cost-calculator`
4. Leave it set to **Public**
5. Click **Create repository**
6. On the next screen, click **uploading an existing file**
7. Upload all the files from the folder you downloaded:
   - `server.js`
   - `package.json`
   - `.env.example`
   - `.gitignore`
   - The `public/` folder containing `index.html`

   **IMPORTANT: Do NOT upload your `.env` file — it contains your secret API key**

8. Click **Commit changes**

---

## Step 3 — Deploy to Render

1. Go to https://render.com and sign in (or create a free account)
2. Click **New** → **Web Service**
3. Connect your GitHub account when prompted
4. Select your `journey-cost-calculator` repository
5. Fill in the settings:

   | Setting | Value |
   |---|---|
   | Name | journey-cost-calculator |
   | Region | Europe (Frankfurt) — or closest to your users |
   | Branch | main |
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Instance Type | **Free** (to start) |

6. Scroll down to **Environment Variables** — this is where your secret API key goes:
   - Click **Add Environment Variable**
   - Key: `ANTHROPIC_API_KEY`
   - Value: paste your Anthropic API key here
   - Click **Save**

7. Click **Create Web Service**

Render will now build and deploy your app. This takes 2–3 minutes.
When it's done, you'll see a URL like `https://journey-cost-calculator.onrender.com` — that's your live app!

---

## Step 4 — Test your live app

Open your Render URL in a browser and test:
- [ ] Change country — fuel prices should update
- [ ] Enter a number plate
- [ ] Search a route (e.g. Manchester to London)
- [ ] Hit Calculate Journey Cost and check results appear

If anything doesn't work, check the **Logs** tab in Render for error messages.

---

## Step 5 — Connect your custom domain (optional)

Once you've bought a domain (e.g. from Namecheap or Cloudflare):

1. In Render, go to your web service → **Settings** → **Custom Domains**
2. Click **Add Custom Domain** and enter your domain (e.g. `journeycost.co.uk`)
3. Render will give you a CNAME record to add
4. Log in to your domain registrar (Namecheap, GoDaddy, etc.)
5. Go to **DNS Settings** and add the CNAME record Render provided
6. Wait 10–30 minutes for it to propagate

Render automatically handles HTTPS/SSL certificates for free.

---

## Step 6 — Set up Google AdSense (optional)

To add adverts to your site:

1. Go to https://adsense.google.com and apply
2. Google will review your site (takes 1–14 days)
3. Once approved, you'll get a code snippet to add to `public/index.html`
4. Add it just before the closing `</head>` tag
5. Then add ad unit code wherever you want ads to appear in the page

Good ad placement for this app:
- Between the Vehicle card and the Journey card
- Below the results panel
- In the page footer area

---

## Upgrading from free tier

When you're ready to go beyond the free tier on Render:
- Free tier: server sleeps after 15 mins inactivity (30 sec wake-up delay)
- Starter ($7/month): always-on, no sleep, custom domains, faster

Upgrade in Render → your service → **Settings** → **Instance Type**.

---

## Monitoring your costs

- **Anthropic usage**: https://console.anthropic.com/settings/usage — check weekly
- **Render**: free tier has no cost, paid tiers are fixed monthly
- **Google Maps** (if you add it later): https://console.cloud.google.com/billing

---

## File structure reference

```
journey-cost-calculator/
├── server.js          ← Backend (handles API calls, caching, rate limiting)
├── package.json       ← Lists the packages the app needs
├── .env.example       ← Template for environment variables (safe to share)
├── .gitignore         ← Tells GitHub what NOT to upload (your .env file)
└── public/
    └── index.html     ← The entire frontend (what users see)
```

---

## Getting help

If you get stuck:
- Render documentation: https://render.com/docs
- Anthropic API docs: https://docs.anthropic.com
- GitHub guides: https://docs.github.com

Common issues:
- **"Application error" on Render**: Check the Logs tab — usually a missing environment variable
- **Lookups not working**: Double-check your ANTHROPIC_API_KEY in Render environment variables
- **Slow first load**: Free tier servers sleep — upgrade to Starter ($7/month) to fix this
