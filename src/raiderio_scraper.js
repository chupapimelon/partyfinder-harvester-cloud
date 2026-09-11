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

function cleanRealmSlug(realm) {
  if (!realm) return '';
  return String(realm)
    .trim()
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Scan Raider.IO M+ leaderboards and add new players to the registry
 * @param {object} registry — Player registry object (from R2)
 * @param {object} options — { region, pageCount, season }
 * @returns {{ newPlayersCount, updatedPlayersCount, lastScannedPage, discovered, error }}
 */
async function scanRaiderIoPages(registry, options = {}) {
  await detectCurrentSeason().catch(() => {});
  const season = options.season || getCurrentSeason();
  const levelCap = options.levelCap || getCurrentLevelCap();
  const region = (options.region || 'us').toLowerCase();
  const pageCount = Math.min(parseInt(options.pageCount, 10) || 2, 10);

  registry.season = season;

  const pageStart = parseInt(registry.lastScannedPage, 10) || 0;

  let runsProcessed = 0;
  let newPlayersCount = 0;
  let updatedPlayersCount = 0;
  let skippedLowLevelCount = 0;
  let lastScannedPage = pageStart;
  let fetchError = null;
  const discoveredList = [];

  for (let p = pageStart; p < pageStart + pageCount; p++) {
    const url = new URL('https://raider.io/api/mythic-plus/rankings/characters');
    url.searchParams.set('region', region);
    url.searchParams.set('season', season);
    url.searchParams.set('class', 'all');
    url.searchParams.set('role', 'all');
    url.searchParams.set('page', String(p));

    let success = false;
    let data = null;
    let lastErr = null;

    // Retry up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url.toString(), {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PartyFinder-CloudHarvester/1.0'
          }
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const bodyTxt = await res.text().catch(() => '');
          if (res.status === 429 || res.status >= 500) {
            console.warn(`[RaiderIO] HTTP ${res.status} on page ${p} (attempt ${attempt}/3), backing off...`);
            await new Promise(r => setTimeout(r, 2000 * attempt));
            continue;
          }
          break;
        }

        data = await res.json();
        success = true;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[RaiderIO] Page ${p} attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    if (!success) {
      console.error(`[RaiderIO] Failed page ${p} after 3 attempts:`, lastErr?.message);
      fetchError = lastErr?.message || 'Network fetch failed';
      break;
    }

    const rankedList = data.rankings?.rankedCharacters || [];
    if (rankedList.length === 0) {
      console.log(`[RaiderIO] No more characters on page ${p}. End of leaderboard reached. Wrapping back to Rank #1 (Page 0)...`);
      registry.lastScannedPage = 0;
      break;
    }

    lastScannedPage = p;
    registry.lastScannedPage = p + 1;

    for (const item of rankedList) {
      const char = item.character;
      if (!char || !char.name || !char.realm) continue;

      // Filter characters below current expansion level cap (e.g. level 80 from old expansions)
      if (char.level && char.level < levelCap) {
        skippedLowLevelCount++;
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
      const overallScore = Math.round((item.score || 0) * 10) / 10;

      let highestKey = 0;
      const runs = item.runs || [];
      for (const run of runs) {
        if ((run.mythicLevel || 0) > highestKey) {
          highestKey = run.mythicLevel;
        }
      }

      if (!registry.players[playerKey]) {
        newPlayersCount++;
        const pObj = {
          name: charName,
          realm: realmName,
          realmSlug: realmSlug,
          region: region.toUpperCase(),
          class: className,
          spec: specName,
          specId: specId,
          role: role,
          highestKey: highestKey || 20,
          rioScore: overallScore,
          runsCount: runs.length || 8,
          firstDiscoveredAt: Date.now(),
          lastSeenAt: Date.now(),
          enriched: false,
          wcl: null,
        };
        registry.players[playerKey] = pObj;
        if (discoveredList.length < 30) {
          discoveredList.push(pObj);
        }
      } else {
        updatedPlayersCount++;
        const existing = registry.players[playerKey];
        existing.lastSeenAt = Date.now();
        existing.rioScore = overallScore;
        if (highestKey > (existing.highestKey || 0)) {
          existing.highestKey = highestKey;
        }
        if (runs.length > (existing.runsCount || 0)) {
          existing.runsCount = runs.length;
        }
      }
    }

    // Polite rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  return {
    newPlayersCount,
    updatedPlayersCount,
    skippedLowLevel: skippedLowLevelCount,
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
