/**
 * season_detector.js — Dynamic Season & Level Cap Auto-Detection
 * 
 * Automatically detects the current active Mythic+ season and character level cap
 * via Raider.IO's static-data API, eliminating hardcoded season slugs and level caps.
 * 
 * Future-proof for Season 3, Season 4, and future expansions (The Last Titan, etc.)
 */

const FALLBACK_SEASON = 'season-mn-2';
const FALLBACK_LEVEL_CAP = 90;
const FALLBACK_EXPANSION_ID = 11;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cachedInfo = {
  slug: FALLBACK_SEASON,
  name: 'MN Season 2',
  expansionId: FALLBACK_EXPANSION_ID,
  levelCap: FALLBACK_LEVEL_CAP,
  detectedAt: 0,
  source: 'fallback'
};

let activeDetectionPromise = null;

/**
 * Detect current season and max level cap dynamically from Raider.IO
 * @param {boolean} forceRefresh - If true, bypasses in-memory cache
 * @returns {Promise<{ slug: string, name: string, expansionId: number, levelCap: number, source: string, detectedAt: number }>}
 */
async function detectCurrentSeason(forceRefresh = false) {
  const nowMs = Date.now();
  if (!forceRefresh && cachedInfo.detectedAt > 0 && (nowMs - cachedInfo.detectedAt < CACHE_TTL_MS)) {
    return cachedInfo;
  }

  if (activeDetectionPromise) {
    return activeDetectionPromise;
  }

  activeDetectionPromise = (async () => {
    const now = new Date();
    let detected = null;

    // Scan expansions from future downwards (15 down to 10)
    for (let expId = 15; expId >= 10; expId--) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(`https://raider.io/api/v1/mythic-plus/static-data?expansion_id=${expId}`, {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PartyFinder-CloudHarvester/1.0 (Windows NT 10.0; Win64; x64)'
          }
        });
        clearTimeout(timeout);

        if (!res.ok) continue;
        const data = await res.json();
        const seasons = data.seasons || [];
        if (!seasons.length) continue;

        // Find active main season
        const active = seasons.find(s => {
          if (!s.is_main_season) return false;
          const startStr = s.starts?.us || s.starts;
          if (!startStr) return false;
          const start = new Date(startStr);
          const endStr = s.ends?.us || s.ends;
          const end = endStr ? new Date(endStr) : new Date('2099-01-01');
          return start <= now && end > now;
        });

        if (active) {
          // Calculate default level cap from expansion formula (Exp 10=80, Exp 11=90, Exp 12=100)
          let levelCap = expId >= 10 ? 80 + (expId - 10) * 10 : FALLBACK_LEVEL_CAP;

          // Attempt to confirm level cap by checking rank #1 character
          try {
            const rankCtrl = new AbortController();
            const rankTimeout = setTimeout(() => rankCtrl.abort(), 6000);
            const rankRes = await fetch(`https://raider.io/api/mythic-plus/rankings/characters?region=us&season=${active.slug}&class=all&role=all&page=0`, {
              signal: rankCtrl.signal,
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'PartyFinder-CloudHarvester/1.0 (Windows NT 10.0; Win64; x64)'
              }
            });
            clearTimeout(rankTimeout);

            if (rankRes.ok) {
              const rankData = await rankRes.json();
              const firstChar = rankData.rankings?.rankedCharacters?.[0]?.character;
              if (firstChar && typeof firstChar.level === 'number' && firstChar.level > 0) {
                levelCap = firstChar.level;
              }
            }
          } catch (rankErr) {
            // Non-fatal, use expansion formula
          }

          detected = {
            slug: active.slug,
            name: active.name || active.slug,
            expansionId: expId,
            levelCap,
            detectedAt: Date.now(),
            source: 'raiderio_api'
          };
          break;
        }
      } catch (err) {
        // Continue to next expansion
      }
    }

    if (detected) {
      cachedInfo = detected;
      console.log(`[SeasonDetector] Auto-detected active season: "${cachedInfo.slug}" (${cachedInfo.name}), Level Cap: ${cachedInfo.levelCap}`);
    } else {
      console.warn(`[SeasonDetector] Could not auto-detect active season. Using fallback: "${FALLBACK_SEASON}", Level Cap: ${FALLBACK_LEVEL_CAP}`);
      cachedInfo = {
        slug: FALLBACK_SEASON,
        name: 'MN Season 2',
        expansionId: FALLBACK_EXPANSION_ID,
        levelCap: FALLBACK_LEVEL_CAP,
        detectedAt: Date.now(),
        source: 'fallback'
      };
    }

    return cachedInfo;
  })().finally(() => {
    activeDetectionPromise = null;
  });

  return activeDetectionPromise;
}

function getCachedSeasonInfo() {
  return cachedInfo;
}

function getCurrentSeason() {
  return cachedInfo.slug;
}

function getCurrentLevelCap() {
  return cachedInfo.levelCap;
}

// Initiate background detection on module load
detectCurrentSeason().catch(() => {});

module.exports = {
  detectCurrentSeason,
  getCachedSeasonInfo,
  getCurrentSeason,
  getCurrentLevelCap,
  FALLBACK_SEASON,
  FALLBACK_LEVEL_CAP,
  FALLBACK_EXPANSION_ID
};
