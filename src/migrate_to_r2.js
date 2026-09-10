/**
 * migrate_to_r2.js — One-time migration script
 * Uploads the local harvest_cache/rio_players_us.json to Cloudflare R2
 * 
 * Run locally: node src/migrate_to_r2.js
 * 
 * Required env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 */

const fs = require('fs');
const path = require('path');
const r2 = require('./r2_client');
const { generateAndUploadPages } = require('./page_generator');

async function main() {
  console.log('=== PartyFinder R2 Migration ===');

  // Find local harvest_cache
  const localPaths = [
    path.resolve(__dirname, '..', '..', '..', '..', 'harvest_cache'),           // From cloud/partyfinder-harvester-cloud/src/
    path.resolve(__dirname, '..', '..', '..', 'harvest_cache'),                  // Alternate
    path.resolve(process.cwd(), 'harvest_cache'),                                 // CWD
    'E:\\PROJECTS\\M+& RAID PARTY FINDER\\harvest_cache',                         // Absolute fallback
  ];

  let localDir = null;
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      localDir = p;
      break;
    }
  }

  if (!localDir) {
    console.error('Could not find harvest_cache directory. Tried:', localPaths);
    process.exit(1);
  }

  console.log(`Found local cache: ${localDir}`);

  const regions = ['us', 'eu', 'kr', 'tw'];

  for (const reg of regions) {
    const filePath = path.join(localDir, `rio_players_${reg}.json`);
    if (!fs.existsSync(filePath)) {
      console.log(`[${reg.toUpperCase()}] No data file found, skipping.`);
      continue;
    }

    const stats = fs.statSync(filePath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
    console.log(`\n[${reg.toUpperCase()}] Found: ${filePath} (${sizeMb} MB)`);

    // Read and parse
    console.log(`[${reg.toUpperCase()}] Loading JSON...`);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const playerCount = data.players ? Object.keys(data.players).length : 0;
    const enrichedCount = data.players ? Object.values(data.players).filter(p => p.enriched).length : 0;

    console.log(`[${reg.toUpperCase()}] Players: ${playerCount.toLocaleString()} (${enrichedCount.toLocaleString()} enriched)`);

    // Upload to R2
    console.log(`[${reg.toUpperCase()}] Uploading to R2: data/rio_players_${reg}.json...`);
    await r2.savePlayerRegistry(reg, data);
    console.log(`[${reg.toUpperCase()}] ✅ Upload complete.`);

    // Generate static API pages
    console.log(`[${reg.toUpperCase()}] Generating static API pages...`);
    await generateAndUploadPages(data, reg, {
      mode: 'migrated',
      lastTickAt: new Date().toISOString(),
      running: true,
    });
    console.log(`[${reg.toUpperCase()}] ✅ Static pages generated.`);

    // Create backup
    const dateStr = new Date().toISOString().split('T')[0];
    console.log(`[${reg.toUpperCase()}] Creating backup: backups/${reg}_${dateStr}.json...`);
    await r2.putJSON(`backups/${reg}_${dateStr}.json`, data, false);
    console.log(`[${reg.toUpperCase()}] ✅ Backup created.`);
  }

  console.log('\n=== Migration Complete ===');
  console.log('Your player data is now in Cloudflare R2.');
  console.log('Local files remain untouched as backup.');
  console.log('\nNext steps:');
  console.log('1. Push this repo to GitHub as a public repo');
  console.log('2. Add secrets to the repo (R2, Supabase, WCL, GitHub deploy token)');
  console.log('3. Enable GitHub Actions — harvester will start running every 5 minutes!');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
