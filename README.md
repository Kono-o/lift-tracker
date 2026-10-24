# Lift Tracker

Workout logging app with day templates, rep and timed exercises, live timers, stats, and cloud sync via Supabase.

**[Live demo](https://lift-tracker-self.vercel.app)** · **[Android releases](https://github.com/Kono-o/lift-tracker/releases)**

## Features

- **Workout templates** — build routines with drag-and-drop ordering and a shared exercise library
- **Weekly or cycle routines** — classic weekday schedules, or a repeating day sequence (e.g. Upper / Rest / Lower / Rest) with a 1–28 slot cycle
- **Per-day overrides & supersets** — override sets, reps, load, or rest for the same exercise on a specific day; chain exercises into supersets
- **Rep & timed exercises** — weight/rep tracking plus countdown timers with a visual progress bar
- **Live workout mode** — session timers, set logging, PR badges, auto rest timer, and overtime tracking
- **Progressive overload** — automatic load progression with per-day override support
- **Built-in exercise catalog** — 900+ movements from [wger](https://wger.de) with search, category/equipment/muscle filters, instructions, and an interactive muscle diagram
- **Workout history & stats** — full session archive with per-exercise set details, plus custom metrics with charts
- **Settings** — dark/OLED themes, haptics, sound effects, reduced motion, rest notifications, and weekly workout reminders
- **Accounts** — sign in with Supabase Auth (Google OAuth on web; native redirect on Android)
- **PWA & Android** — installable web app and sideloadable APK via Capacitor with in-app updates

## Tech stack

| Layer | |
|---|---|
| UI | [SvelteKit](https://kit.svelte.dev/) 2, [Svelte](https://svelte.dev/) 5, [Tailwind CSS](https://tailwindcss.com/) 4 |
| Backend | [Supabase](https://supabase.com/) (Postgres, Auth, RLS) |
| Mobile | [Capacitor](https://capacitorjs.com/) 8 (Android) |

## Quick start (web)

```sh
git clone https://github.com/Kono-o/lift-tracker.git
cd lift-tracker
npm install
cp .env.example .env   # fill in Supabase keys
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | `.env` | Supabase project URL |
| `PUBLIC_SUPABASE_ANON_KEY` | `.env` | Public anon key (safe in frontend) |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env` / deploy | Account deletion API and the wger import script — **never expose to the client or commit it** |
| `SUPABASE_DB_URL` | shell | `scripts/setup-db.fish` / `npm run db:migrate` only (direct Postgres connection) |

See [`.env.example`](.env.example) for Capacitor OAuth and dev-server options.

### Database setup

**Option A — SQL Editor** (first-time setup):

1. Open Supabase Dashboard → SQL Editor
2. Paste and run [`supabase/setup.sql`](supabase/setup.sql)

**Option B — CLI script** (full reset or user wipe; requires `psql`):

```sh
set -Ux SUPABASE_DB_URL 'postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres'
./scripts/setup-db.fish --yes              # full schema reset
./scripts/setup-db.fish --users-only --yes # wipe users + data, keep schema
```

Incremental schema changes live in [`supabase/migrations/`](supabase/migrations/). For an **existing** database that was bootstrapped with an older `setup.sql`, apply pending migrations in filename order:

```sh
set -Ux SUPABASE_DB_URL 'postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres'
npm run db:migrate
```

Or run individual files with `psql "$SUPABASE_DB_URL" -f supabase/migrations/<file>.sql`.

### Exercise catalog (wger)

The exercise catalog is backed by public, read-only tables (`wger_categories`, `wger_equipment`, `wger_muscles`, `wger_exercises`, `wger_exercise_equipment`, `wger_exercise_muscles`). RLS allows `SELECT` for everyone; there are no client-side writes. The schema and RPCs live in [`supabase/migrations/20261024000000_training_overhaul_and_exercise_catalog.sql`](supabase/migrations/20261024000000_training_overhaul_and_exercise_catalog.sql) (also included in `setup.sql`).

Populate it once (or refresh) with the English wger catalog:

```sh
npm run import:wger            # incremental upsert, cached under .cache/wger
npm run import:wger -- --refresh
```

The script pages through `https://wger.de/api/v2/exerciseinfo/?language=2`, throttles requests, caches raw responses, strips HTML from descriptions, and upserts using `SUPABASE_SERVICE_ROLE_KEY` from `.env`. Run it from a trusted machine only; the service-role key is never exposed to the app.

Rebuild the inline muscle diagrams used by the catalog detail view:

```sh
npm run build:svgs
```

This downloads the wger body silhouettes + per-muscle overlay SVGs, verifies they share one coordinate space, then writes `static/svg/front.svg` and `static/svg/back.svg` with one `<g id="muscle-{id}">` per muscle and no hardcoded fill/stroke colors (CSS controls them).

**Attribution:** exercise data and muscle images come from [wger](https://wger.de). Each catalog exercise displays its license and author (`license` / `license_author` fields). Exercise content is generally CC-BY-SA 4.0; wger itself is AGPL-licensed. Keep the in-app attribution if you redistribute the catalog.

## Development

| Command | Description |
|---|---|
| `npm run dev` | Local dev server |
| `npm run dev:phone` | Dev server with LAN URLs for phone testing |
| `npm run dev:tunnel` | Dev server + localtunnel (AP isolation workaround) |
| `npm run build` | Production web build |
| `npm run preview` | Preview production build |
| `npm run check` | Type-check with svelte-check |
| `npm run db:migrate` | Apply pending SQL migrations (needs `SUPABASE_DB_URL`) |
| `npm run import:wger` | Import/refresh the wger exercise catalog |
| `npm run build:svgs` | Rebuild `static/svg/front.svg` + `back.svg` from wger |

### Phone testing

```sh
npm run dev:phone
```

Use the printed `http://<your-lan-ip>:5173` URL on your phone (same Wi‑Fi). If device-to-device traffic is blocked, try `npm run dev:tunnel`.

## Android

Pre-built APKs are on the [Releases](https://github.com/Kono-o/lift-tracker/releases) page.

**For the complete, safe release process (including how to avoid ever rotating the signing key, the exact commands used for v1.0.0 + v1.0.1, faux test releases, GitHub CLI usage, verification, and all the gotchas), read `RELEASE.md`.**

Quick build command (after the first-time setup):

```sh
npm run build:apk:release
```

Output: `android/app/build/outputs/apk/release/lift-tracker-v<version>.apk`

The build script automatically calls the hardened setup script (which reuses the stable key if the files are present) and injects the version from `package.json`.

For native OAuth, add `com.lifttracker.app://auth/callback` in Supabase Auth → URL configuration.

> **Never lose or rotate the signing key.** See `SIGNING.md` and `RELEASE.md`. The two files in `scripts/android-signing/` (gitignored) plus the master copy in `~/lift-tracker-stable-signing/` are what make in-app updates work for existing users.

## Project structure

```
lift-tracker/
├── src/
│   ├── routes/          # SvelteKit pages and API routes
│   └── lib/             # DB layer, components, utilities
├── static/              # PWA manifest, icons, inline muscle SVGs
│   └── svg/             # front.svg / back.svg generated by build:svgs
├── supabase/
│   ├── setup.sql        # Full database bootstrap
│   ├── migrations/      # Incremental schema changes
│   └── seed.sql         # Optional seed data
├── scripts/
│   ├── dev-phone.fish           # Phone-friendly dev server
│   ├── setup-db.fish            # Supabase maintenance
│   ├── import.ts                # wger catalog importer
│   ├── build-svgs.ts            # wger muscle SVG builder
│   ├── build-release-apk.fish   # Signed APK build
│   └── android-signing/         # Release keystore config (secrets gitignored)
├── capacitor.config.ts
├── svelte.config.js
└── vite.config.ts
```

Native `android/` and `ios/` projects are generated by Capacitor (`npm run cap:add:*`) and are not committed.

## Deploy (web)

The app uses `@sveltejs/adapter-vercel` for web deploys. Set `PUBLIC_SUPABASE_*` in your host's environment and deploy like any SvelteKit app (e.g. Vercel). Use `CAPACITOR=1` / `npm run build:capacitor` only for native builds.