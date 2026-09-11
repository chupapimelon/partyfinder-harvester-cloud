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
const { scanRaiderIoPages } = require('./raiderio_scraper');
const { detectCurrentSeason, getCurrentSeason, getCurrentLevelCap } = require('./season_detector');
const { enrichBatch } = require('./wcl_enricher');
const { generateAndUploadPages, uploadStatusOnly } = require('./page_generator');

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
    logs.push(makeLog('info', `[Cloud Tick] Starting 24/7 autonomous worker for [${region.toUpperCase()}]...`));

    // Detect active season and level cap
    const seasonInfo = await detectCurrentSeason().catch(() => ({ slug: getCurrentSeason(), levelCap: getCurrentLevelCap() }));
    console.log(`[Cloud Tick] Active season: ${seasonInfo.slug}, Max Level Cap: ${seasonInfo.levelCap}`);
    logs.push(makeLog('info', `[Season] Active: ${seasonInfo.slug} (${seasonInfo.name || ''}), Level Cap: ${seasonInfo.levelCap}`));

    // 2. Download player registry from R2
    console.log(`[R2] Downloading player registry for ${region}...`);
    const registry = await r2.loadPlayerRegistry(region);
    const totalBefore = Object.keys(registry.players).length;
    const enrichedBefore = Object.values(registry.players).filter(p => p.enriched).length;
    const pendingBefore = totalBefore - enrichedBefore;
    console.log(`[R2] Loaded: ${totalBefore} players (${enrichedBefore} enriched, ${pendingBefore} pending)`);

    // Check if Clean Slate Reset was requested
    try {
      let isResetRequested = false;
      const { data: secretRows } = await sb.getClient().from('app_secrets').select('key,value');
      const resetSecret = secretRows?.find(s => s.key === 'clean_slate_reset');
      if (resetSecret && resetSecret.value === 'requested') {
        isResetRequested = true;
      }
      const resetReq = await sb.getState('reset_requested').catch(() => null);
      if (resetReq && resetReq.enabled) {
        isResetRequested = true;
      }

      if (isResetRequested) {
        console.log('[Cloud Tick] Clean Slate Reset requested! Wiping R2 registry and restarting from Page 0...');
        logs.push(makeLog('warn', `[Clean Slate Reset] Purged ${totalBefore.toLocaleString()} players from R2. Re-crawling from Page 0 under ${seasonInfo.slug} (Level Cap: ${seasonInfo.levelCap})!`));
        registry.players = {};
        registry.lastScannedPage = 0;
        registry.totalUnique = 0;
        registry.season = seasonInfo.slug;
        registry.levelCap = seasonInfo.levelCap;
        await r2.savePlayerRegistry(region, registry);
        await sb.getClient().from('app_secrets').upsert({ key: 'clean_slate_reset', value: 'completed' }, { onConflict: 'key' });
        await sb.setState('reset_requested', { enabled: false, wipedAt: new Date().toISOString() }).catch(() => {});
        await sb.setState('progress', {
          totalUnique: 0,
          enrichedCount: 0,
          pendingEnrichment: 0,
          percentEnriched: '0.0',
          lastScannedPage: 0,
          season: seasonInfo.slug,
          levelCap: seasonInfo.levelCap,
          updatedAt: new Date().toISOString()
        }).catch(() => {});
        console.log('[Cloud Tick] Clean Slate Reset completed successfully.');
      }
    } catch (resetErr) {
      console.warn('[Cloud Tick] Reset check notice:', resetErr.message);
    }

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

    // Check if user set a manual override or paused harvester
    let manualJob = null;
    try {
      const { data: secretRows } = await sb.getClient().from('app_secrets').select('key,value');
      const statusEntry = secretRows?.find(s => s.key === 'harvester_status');
      const mEntry = secretRows?.find(s => s.key === 'manual_job_state');
      if (mEntry && mEntry.value) {
        manualJob = typeof mEntry.value === 'string' ? JSON.parse(mEntry.value) : mEntry.value;
      }

      if (manualJob && manualJob.running) {
        if (manualJob.paused) {
          console.log('[Cloud Tick] Manual override job is PAUSED by user. Standing by.');
          return;
        }
      } else if (statusEntry && statusEntry.value === 'paused') {
        console.log('[Cloud Tick] Harvester is paused by user override. Standing by.');
        return;
      }
    } catch (e) {}

    // 4. 24/7 Autonomous Cycle Engine: 5 micro-cycles of 10 players each (10 players/min pace = 600/hr)
    const TOTAL_CYCLES = 5;
    const CYCLE_BATCH_SIZE = 10;
    let accumulatedEnrichedThisTick = 0;
    let accumulatedNewThisTick = 0;
    let allRecentEnriched = [];
    let allRecentDiscovered = [];
    let lastTickResult = {};
    const hasWclCreds = !!(wclClientId && wclClientSecret);

    for (let cycle = 0; cycle < TOTAL_CYCLES; cycle++) {
      // Responsively check if user paused or stopped from dashboard
      try {
        const { data: secretRows } = await sb.getClient().from('app_secrets').select('key,value');
        const statusEntry = secretRows?.find(s => s.key === 'harvester_status');
        const mEntry = secretRows?.find(s => s.key === 'manual_job_state');
        if (mEntry && mEntry.value) {
          manualJob = typeof mEntry.value === 'string' ? JSON.parse(mEntry.value) : mEntry.value;
        }

        if (manualJob && manualJob.running) {
          if (manualJob.paused) {
            console.log(`[Cloud Tick] Manual override job PAUSED at cycle ${cycle + 1}/${TOTAL_CYCLES}. Standing by.`);
            logs.push(makeLog('warn', `[Job Control] Sweep PAUSED by user override.`));
            break;
          }
        } else if (statusEntry && statusEntry.value === 'paused') {
          console.log(`[Cloud Tick] Harvester paused by user override at cycle ${cycle + 1}/${TOTAL_CYCLES}. Standing by.`);
          logs.push(makeLog('warn', `[Cloud Tick] Harvester paused by user override.`));
          break;
        }
      } catch (e) {}

      const curTotal = Object.keys(registry.players).length;
      const curEnriched = Object.values(registry.players).filter(p => p.enriched).length;
      const curPending = curTotal - curEnriched;

      // Determine operating mode: If manual override is active, force that mode
      const isManualActive = (manualJob && manualJob.running && !manualJob.paused);
      const targetMode = isManualActive ? manualJob.mode : (curPending > 0 && hasWclCreds ? 'wcl' : 'raiderio');

      if (targetMode === 'wcl' && curPending > 0 && hasWclCreds) {
        console.log(`[Cycle ${cycle + 1}/${TOTAL_CYCLES}] Enriching batch of ${CYCLE_BATCH_SIZE} players with WCL (10/min)...`);
        logs.push(makeLog('info', `[WCL Enricher] Cycle ${cycle + 1}/${TOTAL_CYCLES}: Enriching 10 players...`));

        const result = await enrichBatch(registry, {
          region,
          batchSize: CYCLE_BATCH_SIZE,
          zoneId: config.wclZoneId || 55,
          clientId: wclClientId,
          clientSecret: wclClientSecret,
        });

        if (result.enrichedCount > 0) {
          accumulatedEnrichedThisTick += result.enrichedCount;
          allRecentEnriched = [...result.enrichedPlayers, ...allRecentEnriched].slice(0, 30);
          logs.push(makeLog('success', `[WCL Enricher] +${result.enrichedCount} players enriched (${curEnriched + result.enrichedCount} total).`));
          for (const p of result.enrichedPlayers) {
            const parseStr = p.wcl?.unlogged ? 'UNLOGGED' : `${p.wcl?.medianParse?.toFixed(1)}% median`;
            logs.push(makeLog('info', `  ✓ ${p.name}-${p.realm} (${p.rioScore} R.IO) → ${parseStr}`));
          }

          const cloudWclSync = {
            ...(manualJob || {}),
            running: true,
            paused: false,
            mode: 'wcl',
            region,
            countThisRun: accumulatedEnrichedThisTick,
            recentLogs: logs.slice(-30),
            recentEnriched: allRecentEnriched.slice(-20),
            totalTracked: curTotal,
            lastHeartbeat: Date.now()
          };
          if (manualJob && manualJob.running) {
            manualJob.countThisRun = cloudWclSync.countThisRun;
            manualJob.recentLogs = cloudWclSync.recentLogs;
            manualJob.recentEnriched = cloudWclSync.recentEnriched;
            manualJob.totalTracked = cloudWclSync.totalTracked;
            manualJob.lastHeartbeat = cloudWclSync.lastHeartbeat;
          }
          try {
            await sb.getClient().from('app_secrets').upsert({
              key: 'manual_job_state',
              value: JSON.stringify(manualJob && manualJob.running ? manualJob : cloudWclSync)
            }, { onConflict: 'key' });
          } catch (err) {
            console.warn('[Manual State] Failed to persist state:', err.message);
          }
        }

        lastTickResult = {
          mode: 'wcl',
          enrichedCount: accumulatedEnrichedThisTick,
          recentEnriched: allRecentEnriched,
          remainingInQueue: result.remainingInQueue,
          rateLimit: result.rateLimit,
        };
      } else {
        // DISCOVERY MODE: Scrape new pushers from Raider.IO leaderboards
        console.log(`[Cycle ${cycle + 1}/${TOTAL_CYCLES}] Scanning Raider.IO leaderboards (Season: ${seasonInfo.slug}, Cap: ${seasonInfo.levelCap})...`);
        const result = await scanRaiderIoPages(registry, {
          region,
          pageCount: 5,
          season: seasonInfo.slug,
          levelCap: seasonInfo.levelCap,
        });

        const newFound = result.newPlayersCount || 0;
        accumulatedNewThisTick += newFound;
        const totalInReg = Object.keys(registry.players).length;
        const startPage = result.startPage !== undefined ? result.startPage : (result.nextPage ? result.nextPage - 5 : result.lastScannedPage);
        const endPage = result.endPage !== undefined ? result.endPage : result.lastScannedPage;
        const startRank = (startPage * 100) + 1;
        const endRank = (endPage + 1) * 100;
        const pageSpan = (endPage - startPage + 1);

        if (newFound > 0) {
          logs.push(makeLog('success', `[Raider.IO] Cloud worker scanned ranks #${startRank.toLocaleString()}-#${endRank.toLocaleString()} (Pages ${startPage}-${endPage}, ${pageSpan} pages): +${newFound} newly added. Database: ${totalInReg.toLocaleString()} players.`));
        } else {
          logs.push(makeLog('info', `[Raider.IO] Cloud worker scanned ranks #${startRank.toLocaleString()}-#${endRank.toLocaleString()} (Pages ${startPage}-${endPage}, ${pageSpan} pages): Verified ${result.charactersProcessed || (pageSpan * 100)} characters (all ${totalInReg.toLocaleString()} pushers already tracked in database).`));
        }

        const tickDiscovered = (result.discovered || []).map(p => ({
          name: p.name,
          realm: p.realm,
          realmSlug: p.realmSlug,
          class: p.class,
          spec: p.spec,
          role: p.role,
          rioScore: p.rioScore,
          median: 0,
          metric: p.metric || (p.role === 'Tank' ? 'SPEED' : (p.role === 'Healer' ? 'HPS' : 'DPS')),
          enriched: false,
          unlogged: false,
          time: Date.now()
        }));
        allRecentDiscovered = [...tickDiscovered, ...allRecentDiscovered].slice(0, 30);

        const cloudSyncState = {
          ...(manualJob || {}),
          running: true,
          paused: false,
          mode: 'raiderio',
          region,
          countThisRun: accumulatedNewThisTick,
          page: result.nextPage,
          recentLogs: logs.slice(-30),
          recentDiscovered: allRecentDiscovered.slice(-20),
          totalTracked: totalInReg,
          lastHeartbeat: Date.now()
        };
        if (manualJob && manualJob.running) {
          manualJob.countThisRun = cloudSyncState.countThisRun;
          manualJob.page = cloudSyncState.page;
          manualJob.recentLogs = cloudSyncState.recentLogs;
          manualJob.recentDiscovered = cloudSyncState.recentDiscovered;
          manualJob.totalTracked = cloudSyncState.totalTracked;
          manualJob.lastHeartbeat = cloudSyncState.lastHeartbeat;
        }
        try {
          await sb.getClient().from('app_secrets').upsert({
            key: 'manual_job_state',
            value: JSON.stringify(manualJob && manualJob.running ? manualJob : cloudSyncState)
          }, { onConflict: 'key' });
        } catch (err) {
          console.warn('[Manual State] Failed to persist state:', err.message);
        }

        lastTickResult = {
          mode: 'raiderio',
          newPlayersCount: result.newPlayersCount,
          updatedPlayersCount: result.updatedPlayersCount,
          lastScannedPage: result.lastScannedPage,
          nextPage: result.nextPage,
        };
      }

      // Save registry to R2
      await r2.savePlayerRegistry(region, registry);

      // Upload status.json so dashboard immediately sees the updated counts (+10)
      const currentEnrichedTotal = Object.values(registry.players).filter(p => p.enriched).length;
      const currentPendingTotal = Object.keys(registry.players).length - currentEnrichedTotal;
      const statusData = {
        mode: lastTickResult.mode || targetMode || 'wcl',
        lastTickAt: new Date().toISOString(),
        lastTickResult: lastTickResult,
        recentEnriched: allRecentEnriched,
        recentDiscovered: allRecentDiscovered,
        lastScannedPage: registry.lastScannedPage || 0,
        totalPlayers: Object.keys(registry.players).length,
        rateLimit: lastTickResult.rateLimit || null,
        logs: logs.slice(-30),
        running: true,
        paused: false,
        activeJob: manualJob && manualJob.running ? manualJob : {
          running: true,
          paused: false,
          mode: lastTickResult.mode || 'raiderio',
          region,
          countThisRun: accumulatedNewThisTick,
          page: registry.lastScannedPage || 0
        }
      };
      await uploadStatusOnly(registry, region, statusData);

      // Update Supabase progress state for Realtime
      try {
        const progress = (await sb.getState('progress')) || {};
        progress[region] = {
          lastScannedPage: registry.lastScannedPage || 0,
          totalPlayers: Object.keys(registry.players).length,
          enrichedPlayers: currentEnrichedTotal,
          pendingEnrichment: currentPendingTotal,
          lastTickAt: new Date().toISOString(),
          lastTickMode: lastTickResult.mode || targetMode || 'wcl',
        };
        await sb.setState('progress', progress);
      } catch (e) {}

      // Wait between micro-cycles: WCL needs 48s for 10/min rate limit; Raider.IO takes 2s
      if (cycle < TOTAL_CYCLES - 1) {
        if (targetMode === 'wcl') {
          console.log(`[Cycle ${cycle + 1}/${TOTAL_CYCLES}] Waiting 48s for next 10/min batch...`);
          await new Promise(r => setTimeout(r, 48000));
        } else {
          console.log(`[Cycle ${cycle + 1}/${TOTAL_CYCLES}] Discovery batch complete. Next batch in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    // 5. Regenerate static API pages for top 20 pages
    console.log('[PageGen] Regenerating top static API pages...');
    const finalStatus = {
      mode: lastTickResult.mode || (manualJob && manualJob.running ? manualJob.mode : 'idle'),
      lastTickAt: new Date().toISOString(),
      lastTickResult: lastTickResult,
      recentEnriched: allRecentEnriched,
      recentDiscovered: allRecentDiscovered,
      lastScannedPage: registry.lastScannedPage || 0,
      totalPlayers: Object.keys(registry.players).length,
      rateLimit: lastTickResult.rateLimit || null,
      logs: logs.slice(-30),
      running: true,
      paused: false,
      activeJob: manualJob && manualJob.running ? manualJob : {
        running: true,
        paused: false,
        mode: lastTickResult.mode || 'raiderio',
        region,
        countThisRun: accumulatedNewThisTick,
        page: registry.lastScannedPage || 0
      }
    };
    await generateAndUploadPages(registry, region, finalStatus);
    logs.push(makeLog('success', `[PageGen] Static API pages regenerated.`));

    // 6. Update final logs in Supabase
    try {
      await sb.appendLogs(logs.slice(-10));
    } catch (_) {}

    const totalAfter = Object.keys(registry.players).length;
    const enrichedAfter = Object.values(registry.players).filter(p => p.enriched).length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== 5-minute autonomous run complete in ${elapsed}s ===`);
    console.log(`Total Players: ${totalAfter} | Enriched: ${enrichedAfter} (+${accumulatedEnrichedThisTick} enriched, +${accumulatedNewThisTick} discovered)`);

    // 7. Autonomous 24/7 Chain: If harvester or manual override is still running, trigger next workflow run!
    try {
      const { data: secretRows } = await sb.getClient().from('app_secrets').select('key,value');
      const statusEntry = secretRows?.find(s => s.key === 'harvester_status');
      const ghEntry = secretRows?.find(s => s.key === 'github_token');
      const isHarvesterActive = (statusEntry && statusEntry.value === 'running');
      const isManualActive = (manualJob && manualJob.running && !manualJob.paused);

      if ((isHarvesterActive || isManualActive) && ghEntry && ghEntry.value) {
        console.log('[Autonomous Chain] Harvester/Manual state is ACTIVE. Dispatching next 5-minute cloud cycle...');
        await fetch('https://api.github.com/repos/chupapimelon/partyfinder-harvester-cloud/actions/workflows/harvest.yml/dispatches', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghEntry.value}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'PartyFinder-Autonomous-Worker'
          },
          body: JSON.stringify({ ref: 'main' })
        });
      }
    } catch (chainErr) {
      console.warn('[Autonomous Chain Notice]', chainErr.message);
    }

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
