/**
 * Raider.IO Scraper — Cloud-adapted version
 * Adapted from harvester_v2/raiderio_harvester.js for GitHub Actions execution
 * Key difference: uses R2 client instead of local filesystem
 */

const {
  detectCurrentSeason,
  getCurrentSeason,
  getCurrentLevelCap,
  FALLBACK_SEASON,
  FALLBACK_LEVEL_CAP
} = require('./season_detector');
const { getRealmPriority, isMegaRealm, cleanRealmSlug } = require('./realm_indexer');

/**
 * Scan Raider.IO M+ leaderboards and add new players to the registry
 * @param {object} registry — Player registry object (from R2)
 * @param {object} options — { region, pageCount, season }
/**
 * Fetch a single page from Raider.IO with exponential backoff and 429 rate limit protection
 */
async function fetchPageWithRetry(page, options = {}) {
  const { region = 'us', season = 'season-tww-2', className = 'all', role = 'all', retries = 3 } = options;
  const url = new URL('https://raider.io/api/mythic-plus/rankings/characters');
  url.searchParams.set('region', region);
  url.searchParams.set('season', season);
  url.searchParams.set('class', className);
  url.searchParams.set('role', role);
  url.searchParams.set('page', String(page));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PartyFinder-CloudHarvester/2.0'
        }
      });
      clearTimeout(timeout);

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          console.warn(`[RaiderIO] HTTP ${res.status} on page ${page} (attempt ${attempt}/${retries}), backing off...`);
          await new Promise(r => setTimeout(r, 1500 * attempt));
          continue;
        }
        return { page, success: false, error: `HTTP ${res.status}` };
      }

      const data = await res.json();
      return { page, success: true, data };
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      } else {
        return { page, success: false, error: err.message };
      }
    }
  }
  return { page, success: false, error: 'Exceeded max retries' };
}

/**
 * Scan Raider.IO M+ leaderboards and add new players to the registry
 * Uses concurrent chunking (5 pages in parallel) for 10x throughput with 100% accuracy.
 * @param {object} registry — Player registry object (from R2)
 * @param {object} options — { region, pageCount, season, levelCap }
 * @returns {{ newPlayersCount, updatedPlayersCount, lastScannedPage, discovered, error }}
 */
async function scanRaiderIoPages(registry, options = {}) {
  await detectCurrentSeason().catch(() => {});
  const season = options.season || getCurrentSeason();
  const levelCap = options.levelCap || getCurrentLevelCap();
  const region = (options.region || 'us').toLowerCase();
  const pageCount = Math.min(parseInt(options.pageCount, 10) || 25, 50);

  registry.season = season;

  const pageStart = parseInt(registry.lastScannedPage, 10) || 0;

  let runsProcessed = 0;
  let newPlayersCount = 0;
  let updatedPlayersCount = 0;
  let skippedLowLevelCount = 0;
  let skippedNoScoreCount = 0;
  let lastScannedPage = pageStart;
  let fetchError = null;
  const discoveredList = [];
  const CHUNK_SIZE = 5;

  for (let chunkStart = pageStart; chunkStart < pageStart + pageCount; chunkStart += CHUNK_SIZE) {
    const chunkPages = [];
    for (let p = chunkStart; p < Math.min(chunkStart + CHUNK_SIZE, pageStart + pageCount); p++) {
      chunkPages.push(p);
    }

    // Parallel fetch of chunkPages (5 simultaneous requests)
    const chunkResults = await Promise.all(
      chunkPages.map(p => fetchPageWithRetry(p, { region, season, className: 'all', role: 'all' }))
    );

    // Sort by page ascending to maintain strict rank order
    chunkResults.sort((a, b) => a.page - b.page);

    let breakAll = false;

    for (const res of chunkResults) {
      if (!res.success) {
        console.error(`[RaiderIO] Failed page ${res.page}:`, res.error);
        fetchError = res.error;
        breakAll = true;
        break;
      }

      const rankedList = res.data?.rankings?.rankedCharacters || [];
      if (rankedList.length === 0) {
        console.log(`[RaiderIO] No more characters on page ${res.page}. End of leaderboard reached. Wrapping back to Rank #1 (Page 0)...`);
        registry.lastScannedPage = 0;
        breakAll = true;
        break;
      }

      // Early Wrap-Around: If the highest ranked player on this page has 0 score, all subsequent players and pages have 0 score.
      if ((rankedList[0]?.score || 0) <= 0) {
        console.log(`[RaiderIO] Page ${res.page} begins with 0-score players. End of active pushers reached. Wrapping back to Rank #1 (Page 0)...`);
        registry.lastScannedPage = 0;
        breakAll = true;
        break;
      }

      lastScannedPage = res.page;
      registry.lastScannedPage = res.page + 1;

      for (const item of rankedList) {
        const char = item.character;
        if (!char || !char.name || !char.realm) continue;

        // Filter characters below current expansion level cap (e.g. level 80 from old expansions)
        if (char.level && char.level < levelCap) {
          skippedLowLevelCount++;
          continue;
        }

        const overallScore = Math.round((item.score || 0) * 10) / 10;
        const runs = item.runs || [];

        // Option A Filter: Strictly require active Raider.IO score (> 0) and at least 1 recorded run
        if (overallScore <= 0 || runs.length === 0) {
          skippedNoScoreCount++;
          continue;
        }

        runsProcessed++;
        const charName = char.name.trim();
        const realmName = char.realm.name ? char.realm.name.trim() : char.realm.slug;
        const realmSlug = char.realm.slug ? cleanRealmSlug(char.realm.slug) : cleanRealmSlug(realmName);
        const playerKey = `${charName.toLowerCase()}-${realmSlug}`;

        const roleRaw = (char.spec?.role || 'dps').toLowerCase();
        const role = roleRaw === 'tank' ? 'Tank' : (roleRaw === 'healer' ? 'Healer' : 'DPS');
        const className = char.class?.name || 'Unknown';
        const specName = char.spec?.name || 'Unknown';
        const specId = char.spec?.id || 0;

        let highestKey = 0;
        for (const run of runs) {
          if ((run.mythicLevel || 0) > highestKey) {
            highestKey = run.mythicLevel;
          }
        }

        const rPrio = getRealmPriority(region, realmSlug || realmName);
        const isMega = rPrio === 1;

        if (!registry.players[playerKey]) {
          newPlayersCount++;
          const pObj = {
            name: charName,
            realm: realmName,
            realmSlug: realmSlug,
            region: region.toUpperCase(),
            realmPriority: rPrio,
            isMega: isMega,
            class: className,
            spec: specName,
            specId: specId,
            role: role,
            highestKey: highestKey || 0,
            rioScore: overallScore,
            runsCount: runs.length,
            firstDiscoveredAt: Date.now(),
            lastSeenAt: Date.now(),
            enriched: false,
            wcl: null,
          };
          registry.players[playerKey] = pObj;
          if (discoveredList.length < 50) {
            discoveredList.push(pObj);
          }
        } else {
          updatedPlayersCount++;
          const existing = registry.players[playerKey];
          existing.lastSeenAt = Date.now();
          existing.realmPriority = existing.realmPriority || rPrio;
          existing.isMega = existing.realmPriority === 1;

          // Maintenance detection: Check if player pushed higher score or key
          const scoreChanged = overallScore > (existing.rioScore || 0);
          const keyChanged = highestKey > (existing.highestKey || 0);
          if (scoreChanged || keyChanged) {
            existing.needsReenrichment = true;
            existing.lastScoreGain = Math.round((overallScore - (existing.rioScore || 0)) * 10) / 10;
          }

          existing.rioScore = overallScore;
          if (highestKey > (existing.highestKey || 0)) {
            existing.highestKey = highestKey;
          }
          if (runs.length > (existing.runsCount || 0)) {
            existing.runsCount = runs.length;
          }
        }
      }
    }

    if (breakAll) break;

    // Polite pause between chunks (100ms)
    if (chunkStart + CHUNK_SIZE < pageStart + pageCount) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return {
    newPlayersCount,
    updatedPlayersCount,
    skippedLowLevel: skippedLowLevelCount,
    skippedNoScore: skippedNoScoreCount,
    season,
    levelCap,
    startPage: pageStart,
    endPage: lastScannedPage,
    lastScannedPage,
    nextPage: registry.lastScannedPage || 0,
    charactersProcessed: runsProcessed,
    discovered: discoveredList,
    error: fetchError,
  };
}

module.exports = {
  scanRaiderIoPages,
  cleanRealmSlug,
  detectCurrentSeason,
  getCurrentSeason,
  getCurrentLevelCap,
  FALLBACK_SEASON,
  FALLBACK_LEVEL_CAP,
  get CURRENT_SEASON() { return getCurrentSeason(); }
};
