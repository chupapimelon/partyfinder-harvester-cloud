# PartyFinder Cloud Harvester 🌐

**24/7 automated WoW M+ player data harvester** — runs for free via GitHub Actions, stores data in Cloudflare R2.

## Architecture

```
GitHub Actions (every 5 min) → Raider.IO API / WCL API → Cloudflare R2 (player data)
                                                       → Supabase (state only)
                                                       → GitHub API → Cloudflare Pages CDN
```

- **$0/month** — No credit card required
- **GitHub Actions** — Unlimited free minutes (public repo)
- **Cloudflare R2** — 10 GB free storage, zero egress fees
- **Supabase** — Free tier, stores only harvester state (< 1 MB)

## Setup

### 1. Create Cloudflare R2 Bucket

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → R2
2. Create bucket: `partyfinder-data`
3. Create API token: R2 → Manage R2 API Tokens → Create API Token
4. Note: Account ID, Access Key ID, Secret Access Key

### 2. Run Supabase Migration

1. Go to [Supabase Dashboard](https://supabase.com/dashboard) → SQL Editor
2. Paste and run `supabase_migration.sql`

### 3. Migrate Local Data to R2

```bash
export R2_ACCOUNT_ID=your_account_id
export R2_ACCESS_KEY_ID=your_access_key
export R2_SECRET_ACCESS_KEY=your_secret_key
export R2_BUCKET_NAME=partyfinder-data

npm install
node src/migrate_to_r2.js
```

### 4. Push to GitHub (Public Repo)

```bash
git init
git remote add origin https://github.com/chupapimelon/partyfinder-harvester-cloud.git
git add .
git commit -m "Initial cloud harvester setup"
git push -u origin main
```

### 5. Add GitHub Secrets

Go to repo Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 API access key |
| `R2_SECRET_ACCESS_KEY` | R2 API secret key |
| `R2_BUCKET_NAME` | `partyfinder-data` |
| `WCL_CLIENT_ID` | Warcraft Logs client ID |
| `WCL_CLIENT_SECRET` | Warcraft Logs client secret |
| `DEPLOY_TOKEN` | GitHub fine-grained PAT (repo:contents write on imong-mama-ui) |

### 6. Enable Actions

The harvester will start automatically running every 5 minutes!

Check: Actions tab → "PartyFinder Harvester" → green checkmarks ✅

## Workflows

| Workflow | Schedule | Purpose |
|---|---|---|
| `harvest.yml` | Every 5 min | Scrape Raider.IO + Enrich WCL → save to R2 |
| `deploy_cdn.yml` | Every hour | Compile Lua → push to GitHub → Cloudflare Pages CDN |

## License

MIT
