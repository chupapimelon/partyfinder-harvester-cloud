/**
 * Static Page Generator — Pre-generates paginated API files for the dashboard
 * Uploads to R2 so the dashboard can load small JSON files instead of the full 500MB database
 */

const r2 = require('./r2_client');

const PAGE_SIZE = 50; // Players per page

/**
 * Generate all static API files for a region and upload to R2
 * @param {object} registry — Full player registry
 * @param {string} region — 'us', 'eu', etc.
 * @param {object} statusData — Current harvester status for status.json
 */
async function generateAndUploadPages(registry, region, statusData = {}) {
  const reg = (region || 'us').toLowerCase();
  const players = Object.values(registry.players || {});

  // Sort by R.IO score descending (same as local dashboard)
  players.sort((a, b) => (b.rioScore || 0) - (a.rioScore || 0));

  const totalPlayers = players.length;
  const enrichedCount = players.filter(p => p.enriched).length;
  const pendingCount = totalPlayers - enrichedCount;
  const totalPages = Math.ceil(totalPlayers / PAGE_SIZE) || 1;

  console.log(`[PageGen] Generating ${totalPages} pages for ${reg.toUpperCase()} (${totalPlayers} players)...`);

  // 1. Generate meta.json
  const meta = {
    region: reg.toUpperCase(),
    totalPlayers,
    enrichedPlayers: enrichedCount,
    pendingEnrichment: pendingCount,
    totalPages,
    pageSize: PAGE_SIZE,
    lastScannedPage: registry.lastScannedPage || 0,
    updatedAt: Date.now(),
    updatedAtISO: new Date().toISOString(),
  };
  await r2.putJSON(`api/${reg}/meta.json`, meta);

  // 2. Generate paginated player files
  // Only regenerate the top active pages (first 20 pages = top 1,000 players) on regular ticks to save R2 writes and prevent job timeouts
  const pagesToGenerate = Math.min(totalPages, 20);
  const uploadPromises = [];
  for (let i = 0; i < pagesToGenerate; i++) {
    const pageNum = String(i + 1).padStart(4, '0');
    const start = i * PAGE_SIZE;
    const pageData = players.slice(start, start + PAGE_SIZE).map(p => ({
      name: p.name,
      realm: p.realm,
      realmSlug: p.realmSlug,
      region: p.region || reg.toUpperCase(),
      class: p.class,
      spec: p.spec,
      specId: p.specId,
      role: p.role,
      rioScore: p.rioScore || 0,
      highestKey: p.highestKey || 0,
      enriched: !!p.enriched,
      bestParse: p.wcl?.bestParse || 0,
      medianParse: p.wcl?.medianParse || 0,
      totalKills: p.wcl?.totalRuns || 0,
      unlogged: p.wcl?.unlogged || false,
    }));

    uploadPromises.push(r2.putJSON(`api/${reg}/page_${pageNum}.json`, {
      page: i + 1,
      totalPages,
      totalPlayers,
      players: pageData,
    }));

    // Batch uploads in groups of 20 to avoid overwhelming R2
    if (uploadPromises.length >= 20) {
      await Promise.all(uploadPromises);
      uploadPromises.length = 0;
    }
  }
  // Flush remaining
  if (uploadPromises.length > 0) {
    await Promise.all(uploadPromises);
  }

  // 3. Generate alphabetical search index files (a-z + misc)
  const searchBuckets = {};
  for (const p of players) {
    const firstChar = (p.name || '?')[0].toLowerCase();
    const bucket = /[a-z]/.test(firstChar) ? firstChar : 'misc';
    if (!searchBuckets[bucket]) searchBuckets[bucket] = [];
    searchBuckets[bucket].push({
      name: p.name,
      realm: p.realm,
      realmSlug: p.realmSlug,
      class: p.class,
      spec: p.spec,
      role: p.role,
      rioScore: p.rioScore || 0,
      enriched: !!p.enriched,
      medianParse: p.wcl?.medianParse || 0,
    });
  }

  const searchPromises = [];
  for (const [letter, letterPlayers] of Object.entries(searchBuckets)) {
    // Sort each bucket by rio score
    letterPlayers.sort((a, b) => (b.rioScore || 0) - (a.rioScore || 0));
    searchPromises.push(r2.putJSON(`api/${reg}/search_${letter}.json`, {
      letter,
      count: letterPlayers.length,
      players: letterPlayers,
    }));
  }
  await Promise.all(searchPromises);

  // 4. Generate realm list
  const realmCounts = {};
  for (const p of players) {
    const realm = p.realm || 'Unknown';
    if (!realmCounts[realm]) {
      realmCounts[realm] = { name: realm, slug: p.realmSlug || '', count: 0 };
    }
    realmCounts[realm].count++;
  }
  const realms = Object.values(realmCounts).sort((a, b) => b.count - a.count);
  await r2.putJSON(`api/${reg}/realms.json`, { realms });

  // 5. Generate status.json (harvester telemetry)
  const status = {
    ...statusData,
    region: reg.toUpperCase(),
    totalPlayers,
    enrichedPlayers: enrichedCount,
    pendingEnrichment: pendingCount,
    lastScannedPage: registry.lastScannedPage || 0,
    updatedAt: Date.now(),
    updatedAtISO: new Date().toISOString(),
  };
  await r2.putJSON('api/status.json', status);

  console.log(`[PageGen] Done: ${totalPages} pages + ${Object.keys(searchBuckets).length} search indexes + realms + status uploaded.`);

  return { totalPages, meta };
}

module.exports = { generateAndUploadPages };
