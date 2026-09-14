/**
 * WCL Enricher — Cloud-adapted version
 * Adapted from harvester_v2/wcl_enricher.js for GitHub Actions execution
 * Key difference: credentials from env vars or Supabase, operates on in-memory registry
 */

const { isMegaRealm, getRealmPriority } = require('./realm_indexer');

let cachedWclToken = null;
let tokenExpiresAt = 0;

/**
 * Get WCL OAuth access token
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {string} Access token
 */
async function getWclAccessToken(clientId, clientSecret) {
  const now = Date.now();
  if (cachedWclToken && now < tokenExpiresAt - 60000) {
    return cachedWclToken;
  }

  const tokenRes = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!tokenRes.ok) {
    throw new Error(`WCL OAuth failed (${tokenRes.status})`);
  }

  const tokenData = await tokenRes.json();
  cachedWclToken = tokenData.access_token;
  const ttlSeconds = tokenData.expires_in || 3600;
  tokenExpiresAt = now + (ttlSeconds * 1000);
  return cachedWclToken;
}

/**
 * Check live rate limit state for an API client
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<{ limitPerHour: number, pointsSpentThisHour: number, pointsResetIn: number } | null>}
 */
async function checkLiveRateLimit(clientId, clientSecret) {
  try {
    const token = await getWclAccessToken(clientId, clientSecret);
    const query = '{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }';
    const res = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const qData = await res.json();
    return qData.data?.rateLimitData || null;
  } catch (err) {
    console.warn('[WCL] Failed to check live rate limit:', err.message);
    return null;
  }
}

/**
 * Enrich a batch of un-enriched players with WCL combat parse data
 * @param {object} registry — Player registry object (from R2, modified in-place)
 * @param {object} options — { region, batchSize, zoneId, clientId, clientSecret, fastMode }
 * @returns {{ enrichedCount, remainingInQueue, enrichedPlayers }}
 */
async function enrichBatch(registry, options = {}) {
  const region = (options.region || 'us').toLowerCase();
  const batchSize = Math.min(parseInt(options.batchSize, 10) || 10, 100);
  const zoneId = options.zoneId || 55;

  const targetPriority = options.targetPriority || 1; // 1 = P1 Mega, 'maintenance' = changed pushers, 'p2_p3' = Mid/Low, 'all' = any
  const MIN_ENRICH_SCORE = parseInt(process.env.MIN_ENRICH_SCORE || '3000', 10);
  const minScore = options.minScore !== undefined ? options.minScore : MIN_ENRICH_SCORE;

  let candidatePlayers = [];
  if (targetPriority === 'maintenance') {
    candidatePlayers = Object.values(registry.players).filter(p => p.needsReenrichment);
  } else if (targetPriority === 1) {
    candidatePlayers = Object.values(registry.players).filter(p => !p.enriched && (p.realmPriority === 1 || p.isMega || isMegaRealm(region, p.realmSlug || p.realm)));
    // Fallback: If all P1 Mega Realm pushers are enriched, smoothly fall back to P2/P3 so quota is never wasted
    if (candidatePlayers.length === 0) {
      candidatePlayers = Object.values(registry.players).filter(p => !p.enriched);
    }
  } else if (targetPriority === 'p2_p3') {
    candidatePlayers = Object.values(registry.players).filter(p => !p.enriched && (p.realmPriority > 1 || (!p.isMega && !isMegaRealm(region, p.realmSlug || p.realm))));
    if (candidatePlayers.length === 0) {
      candidatePlayers = Object.values(registry.players).filter(p => !p.enriched);
    }
  } else {
    candidatePlayers = Object.values(registry.players).filter(p => !p.enriched);
  }

  // Filter candidates to active competitive pushers (>= minScore)
  candidatePlayers = candidatePlayers.filter(p => (p.rioScore || 0) >= minScore);

  const unEnriched = candidatePlayers.sort((a, b) => (b.rioScore || 0) - (a.rioScore || 0));

  if (unEnriched.length === 0) {
    return {
      enrichedCount: 0,
      remainingInQueue: 0,
      enrichedPlayers: [],
      message: 'No un-enriched players in queue for active priority tier.',
    };
  }

  const targetBatch = unEnriched.slice(0, batchSize);
  const token = await getWclAccessToken(options.clientId, options.clientSecret);
  const enrichedResults = [];
  let rateLimitExhausted = false;

  for (const player of targetBatch) {
    const cleanSlug = (player.realmSlug || player.realm || '')
      .toLowerCase()
      .replace(/['']/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    const playerKey = `${player.name.toLowerCase()}-${cleanSlug}`;

    // Choose WCL metric: Tank=playerspeed, Healer=hps, DPS=dps
    const metric = player.role === 'Tank' ? 'playerspeed' : (player.role === 'Healer' ? 'hps' : 'dps');

    const query = `
      query {
        rateLimitData {
          limitPerHour
          pointsSpentThisHour
          pointsResetIn
        }
        characterData {
          character(name: "${player.name}", serverSlug: "${cleanSlug}", serverRegion: "${(player.region || region).toLowerCase()}") {
            id
            classID
            zoneRankings(zoneID: ${zoneId}, metric: ${metric})
          }
        }
      }
    `;

    try {
      const res = await fetch('https://www.warcraftlogs.com/api/v2/client', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      if (!res.ok) {
        console.warn(`[WCL] HTTP ${res.status} for ${playerKey}`);
        if (res.status === 429) {
          console.warn('[WCL] Rate limit 429 — hourly quota exhausted.');
          rateLimitExhausted = true;
          break;
        }
        continue;
      }

      const qData = await res.json();
      if (qData.data?.rateLimitData) {
        latestRateLimit = qData.data.rateLimitData;
        if (latestRateLimit.pointsSpentThisHour >= (latestRateLimit.limitPerHour - 300)) {
          console.warn(`[WCL] Safe ceiling reached: ${latestRateLimit.pointsSpentThisHour}/${latestRateLimit.limitPerHour} pts.`);
          rateLimitExhausted = true;
          break;
        }
      }

      if (qData.errors && qData.errors.length > 0) {
        console.warn(`[WCL] GraphQL error for ${playerKey}:`, qData.errors[0].message);
        continue;
      }

      const charData = qData.data?.characterData?.character;
      const rankings = charData?.zoneRankings;

      let medianParse = 0;
      let bestParse = 0;
      let totalRuns = 0;
      let isUnlogged = false;

      if (rankings && rankings.allOverview && rankings.allOverview.length > 0) {
        const parses = rankings.allOverview.map(r => r.rankPercent || 0).sort((a, b) => a - b);
        bestParse = Math.max(...parses, 0);
        const mid = Math.floor(parses.length / 2);
        medianParse = parses.length % 2 !== 0 ? parses[mid] : ((parses[mid - 1] + parses[mid]) / 2);
        totalRuns = rankings.totalRuns || parses.length;
      } else if (rankings && typeof rankings.bestPerformanceAverage === 'number') {
        bestParse = rankings.bestPerformanceAverage || 0;
        medianParse = rankings.medianPerformanceAverage || bestParse;
        totalRuns = rankings.totalRuns || 0;
      } else {
        isUnlogged = true;
      }

      // Update player record in-place
      player.enriched = true;
      player.needsReenrichment = false;
      player.lastEnrichedAt = Date.now();
      player.wcl = {
        characterId: charData?.id || null,
        metric: metric.toUpperCase(),
        bestParse: Math.round(bestParse * 10) / 10,
        medianParse: Math.round(medianParse * 10) / 10,
        totalRuns: totalRuns,
        unlogged: isUnlogged,
        zoneId: zoneId,
      };

      registry.players[playerKey] = player;
      enrichedResults.push(player);

      // Dynamic polite pause: 35ms in fast/platinum mode, 100ms in standard mode
      const pauseMs = options.fastMode ? 35 : 100;
      await new Promise(r => setTimeout(r, pauseMs));
    } catch (err) {
      console.error(`[WCL] Error enriching ${playerKey}:`, err.message);
    }
  }

  return {
    enrichedCount: enrichedResults.length,
    remainingInQueue: unEnriched.length - enrichedResults.length,
    enrichedPlayers: enrichedResults,
    rateLimit: latestRateLimit,
    rateLimitExhausted,
  };
}

module.exports = {
  enrichBatch,
  getWclAccessToken,
  checkLiveRateLimit,
};
