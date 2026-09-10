/**
 * harvest_tick.js — Main entry point for each GitHub Actions cron tick
 * 
 * Runs every 5 minutes via GitHub Actions. Each tick:
 * 1. Downloads player registry from R2
 * 2. Either enriches players (WCL) or discovers new ones (Raider.IO)
 * 3. Uploads updated registry back to R2
 * 4. Regenerates static API pages
 * 5. Updates Supabase harvester state (for real-time dashboard sync)
 */

const r2 = require('./r2_client');
const sb = require('./supabase_client');
const { scanRaiderIoPages, CURRENT_SEASON } = require('./raiderio_scraper');
const { enrichBatch } = require('./wcl_enricher');
const { generateAndUploadPages } = require('./page_generator');

// WCL credentials — from GitHub Secrets env vars or Supabase vault
const WCL_CLIENT_ID = process.env.WCL_CLIENT_ID;
const WCL_CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;

function makeLog(type, message) {
  return { type, message, time: new Date().toTimeString().split(' ')[0], id: Date.now() + Math.random() };
}

async function main() {
  const startTime = Date.now();
  const logs = [];

  try {
    console.log('=== PartyFinder Cloud Harvester Tick ===');
    console.log(`Time: ${new Date().toISOString()}`);

    // 1. Read config from Supabase
    const config = (await sb.getState('config')) || {
      primaryRegion: 'us',
      batchSize: 10,
      autoDeployIntervalMin: 60,
      wclZoneId: 55,
    };
    const region = (config.primaryRegion || 'us').toLowerCase();
    logs.push(makeLog('info', `[Cloud Tick] Starting for region [${region.toUpperCase()}]...`));

    // 2. Download player registry from R2
    console.log(`[R2] Downloading player registry for ${region}...`);
    const registry = await r2.loadPlayerRegistry(region);
    const totalBefore = Object.keys(registry.players).length;
    const enrichedBefore = Object.values(registry.players).filter(p => p.enriched).length;
    const pendingBefore = totalBefore - enrichedBefore;
    console.log(`[R2] Loaded: ${totalBefore} players (${enrichedBefore} enriched, ${pendingBefore} pending)`);

    // 3. Get WCL credentials
    let wclClientId = WCL_CLIENT_ID;
    let wclClientSecret = WCL_CLIENT_SECRET;
    if (!wclClientId || !wclClientSecret) {
      const creds = await sb.getWclCredentials();
      if (creds) {
        wclClientId = creds.clientId;
        wclClientSecret = creds.clientSecret;
      }
    }

    // 4. Decide: Enrich or Discover
    let tickResult = {};
    const hasWclCreds = !!(wclClientId && wclClientSecret);

    if (pendingBefore > 0 && hasWclCreds) {
      // ENRICH MODE — Process un-enriched players via WCL
      console.log(`[WCL] Enriching batch of ${config.batchSize || 10} players...`);
      logs.push(makeLog('info', `[WCL Enricher] Processing batch of ${config.batchSize || 10} from ${pendingBefore} pending...`));

      const result = await enrichBatch(registry, {
        region,
        batchSize: config.batchSize || 10,
        zoneId: config.wclZoneId || 55,
        clientId: wclClientId,
        clientSecret: wclClientSecret,
      });

      tickResult = {
        mode: 'wcl',
        enrichedCount: result.enrichedCount,
        remainingInQueue: result.remainingInQueue,
      };

      if (result.enrichedCount > 0) {
        logs.push(makeLog('success', `[WCL Enricher] Enriched ${result.enrichedCount} players. ${result.remainingInQueue} remaining.`));
        for (const p of result.enrichedPlayers.slice(0, 5)) {
          const parseStr = p.wcl?.unlogged ? 'UNLOGGED' : `${p.wcl?.medianParse?.toFixed(1)}% median`;
          logs.push(makeLog('info', `  ✓ ${p.name}-${p.realm} (${p.rioScore} R.IO) → ${parseStr}`));
        }
      } else {
        logs.push(makeLog('warn', `[WCL Enricher] No players enriched this tick.`));
      }
    } else {
      // DISCOVERY MODE — Scrape new players from Raider.IO
      console.log(`[RaiderIO] Scraping ${2} pages from page ${registry.lastScannedPage}...`);
      logs.push(makeLog('info', `[Raider.IO] Scanning pages ${registry.lastScannedPage}-${registry.lastScannedPage + 1}...`));

      const result = await scanRaiderIoPages(registry, {
        region,
        pageCount: 2,
        season: CURRENT_SEASON,
      });

      tickResult = {
        mode: 'raiderio',
        newPlayersCount: result.newPlayersCount,
        updatedPlayersCount: result.updatedPlayersCount,
        lastScannedPage: result.lastScannedPage,
        nextPage: result.nextPage,
      };

      if (result.newPlayersCount > 0) {
        logs.push(makeLog('success', `[Raider.IO] Discovered ${result.newPlayersCount} new players, updated ${result.updatedPlayersCount}. Next page: ${result.nextPage}`));
      } else {
        logs.push(makeLog('info', `[Raider.IO] Updated ${result.updatedPlayersCount} existing players. Next page: ${result.nextPage}`));
      }

      if (result.error) {
        logs.push(makeLog('error', `[Raider.IO] Error: ${result.error}`));
      }
    }

    // 5. Upload updated registry back to R2
    console.log('[R2] Uploading updated player registry...');
    await r2.savePlayerRegistry(region, registry);
    const totalAfter = Object.keys(registry.players).length;
    const enrichedAfter = Object.values(registry.players).filter(p => p.enriched).length;
    console.log(`[R2] Saved: ${totalAfter} players (${enrichedAfter} enriched)`);
    logs.push(makeLog('success', `[R2] Registry saved: ${totalAfter.toLocaleString()} players.`));

    // 6. Regenerate static API pages
    console.log('[PageGen] Regenerating static API pages...');
    const statusData = {
      mode: tickResult.mode || 'idle',
      lastTickAt: new Date().toISOString(),
      lastTickResult: tickResult,
      running: true,
      paused: false,
    };
    await generateAndUploadPages(registry, region, statusData);
    logs.push(makeLog('success', `[PageGen] Static API pages regenerated.`));

    // 7. Update Supabase harvester state (triggers Realtime for dashboard/desktop)
    const progress = await sb.getState('progress') || {};
    progress[region] = {
      lastScannedPage: registry.lastScannedPage || 0,
      totalPlayers: totalAfter,
      enrichedPlayers: enrichedAfter,
      pendingEnrichment: totalAfter - enrichedAfter,
      lastTickAt: new Date().toISOString(),
      lastTickMode: tickResult.mode || 'idle',
    };
    await sb.setState('progress', progress);
    await sb.appendLogs(logs);

    // Update recent_discovered if we have new players
    if (tickResult.mode === 'raiderio' && tickResult.newPlayersCount > 0) {
      const existing = (await sb.getState('recent_discovered')) || [];
      // Keep last 30 discovered entries
      const discovered = tickResult.discovered || [];
      const combined = [...discovered.slice(0, 10), ...existing].slice(0, 30);
      await sb.setState('recent_discovered', combined);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Tick complete in ${elapsed}s ===`);
    console.log(`Mode: ${tickResult.mode} | Players: ${totalAfter} | Enriched: ${enrichedAfter}`);

  } catch (err) {
    console.error('[FATAL] Harvest tick failed:', err);
    logs.push(makeLog('error', `[FATAL] ${err.message}`));
    try {
      await sb.appendLogs(logs);
    } catch (_) {}
    process.exit(1);
  }
}

main();
