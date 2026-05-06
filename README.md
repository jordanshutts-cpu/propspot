# 📸 FieldCam — Setup Guide

Field photo management for renovation contractors.
Runs on **Railway** with a PostgreSQL database and Cloudinary photo storage.

---

## Architecture

```
Browser (HTML/CSS/JS)
      ↕  fetch() + JWT
Express Server  ──→  Railway PostgreSQL  (users, properties, photos)
      ↕
    Cloudinary  (photo storage + CDN)
```

---

## Setup (20 minutes)

### Step 1 — Create a Cloudinary Account (free)

1. Go to **[https://cloudinary.com](https://cloudinary.com)** → Sign up free
2. From your dashboard, copy:
   - **Cloud Name**
   - **API Key**
   - **API Secret**

### Step 2 — Create a Railway Account

1. Go to **[https://railway.app](https://railway.app)** → Sign up with GitHub
2. Click **New Project** → **Empty Project**
3. Click **+ Add a Service** → **Database** → **PostgreSQL**
   - Railway auto-provisions a Postgres database and gives you `DATABASE_URL`

### Step 3 — Deploy FieldCam to Railway

**Option A — GitHub (recommended, enables auto-deploy):**
1. Push this folder to a new GitHub repo
2. In Railway: **+ Add a Service** → **GitHub Repo** → select your repo
3. Railway detects `package.json` and deploys automatically

**Option B — Railway CLI:**
```bash
npm install -g @railway/cli
railway login
railway link          # link to your project
railway up            # deploy
```

### Step 4 — Set Environment Variables in Railway

In your Railway service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Auto-filled by Railway when you add Postgres |
| `JWT_SECRET` | Any long random string (32+ chars) |
| `JWT_EXPIRES_IN` | `30d` |
| `CLOUDINARY_CLOUD_NAME` | From Cloudinary dashboard |
| `CLOUDINARY_API_KEY` | From Cloudinary dashboard |
| `CLOUDINARY_API_SECRET` | From Cloudinary dashboard |
| `APP_URL` | Your Railway public URL (e.g. `https://fieldcam-production.up.railway.app`) |

**Optional — Email invites (Gmail example):**

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `you@gmail.com` |
| `SMTP_PASS` | Your Gmail App Password |
| `FROM_EMAIL` | `FieldCam <you@gmail.com>` |

> If SMTP is not configured, invite links are shown in the UI for manual sharing.

### Step 5 — Get Your Live URL

- In Railway → your service → **Settings** → **Networking** → **Generate Domain**
- Your app is live at `https://your-app.railway.app`
- Share this URL with your team!

---

## Inviting Your Team

1. Open the app → **Team** tab (👥)
2. Enter their email and click **Send Invite**
3. They get an email (or you copy the link manually)
4. They click the link → set a password → they're in

---

## Connecting to Your Partners' Railway Projects

Since everything is on Railway with standard REST APIs, connecting is straightforward:

1. **Share API endpoints** — your partners can call `https://your-app.railway.app/api/...`
2. **Add API keys** — create a shared `API_KEY` env var for service-to-service auth
3. **Private networking** — Railway projects in the same organization can communicate
   via Railway's private network (`http://fieldcam.railway.internal`)

Ask your partners for their Railway project's internal hostname and we can wire up the integration.

---

## File Structure

```
FieldCam/
├── server.js              Express entry point — serves API + static files
├── package.json
├── railway.toml           Railway deployment config
├── .env.example           Copy to .env for local development
├── .gitignore
│
├── db/
│   ├── index.js           PostgreSQL pool + schema runner
│   └── schema.sql         Table definitions (auto-run on startup)
│
├── middleware/
│   └── auth.js            JWT verification middleware
│
├── routes/
│   ├── auth.js            POST /api/auth/* (signup, login, invite, accept-invite)
│   ├── properties.js      GET/POST/PATCH/DELETE /api/properties
│   ├── photos.js          GET/POST/DELETE /api/photos (Cloudinary upload)
│   └── team.js            GET /api/team
│
└── public/                Frontend (served as static files by Express)
    ├── index.html          Login / Sign Up
    ├── dashboard.html      Properties list with GPS nearby detection
    ├── property.html       Photo gallery per property
    ├── camera.html         Live camera + GPS photo capture
    ├── add-property.html   Add property with one-tap GPS pin
    ├── team.html           Invite & manage team
    ├── accept-invite.html  Invite acceptance page (linked in invite emails)
    ├── app.js              Shared fetch() API client + utilities
    ├── config.js           API base URL config
    └── style.css           Mobile-first UI styles
```

---

## Local Development

```bash
# 1. Install Node.js from https://nodejs.org (LTS version)
# 2. Install dependencies
npm install

# 3. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your Cloudinary keys and a local Postgres URL

# 4. Run the server
npm run dev     # uses nodemon for auto-restart
# OR
npm start       # plain node

# 5. Open http://localhost:3000
```

---

## Tips for Field Use

- **Bookmark** `https://your-app.railway.app` on your phone's home screen
- The camera page **auto-highlights** the nearest property (within 300m)
- Photos store the **exact GPS coordinates** of where they were taken
- Workers can add **notes** to each photo (e.g. "north wall framing done")
- Invited users show as **Invited** in the team list until they set a password
