/**
 * deploy_cdn.js — Compile player data to Lua and deploy to Cloudflare R2 CDN
 * Generates both Global and Regional (US) databases, plus fast Gzip (.gz) streams.
 * 
 * Triggered hourly via GitHub Actions cron
 */

const crypto = require('crypto');
const zlib = require('zlib');
const r2 = require('./r2_client');
const sb = require('./supabase_client');
const { getCurrentLevelCap } = require('./season_detector');
const { getSubRegion } = require('./subregion_engine');

const GITHUB_DEPLOY_TOKEN = process.env.GITHUB_DEPLOY_TOKEN;
const GITHUB_REPO = 'chupapimelon/imong-mama-ui';

// Spec ID → binary index mapping (from compiler.js)
const SPEC_TO_INDEX = {
  250: 1, 251: 2, 252: 3, 577: 4, 581: 5,
  102: 6, 103: 7, 104: 8, 105: 9,
  1467: 10, 1468: 11, 1473: 12,
  253: 13, 254: 14, 255: 15,
  62: 16, 63: 17, 64: 18,
  268: 19, 269: 20, 270: 21,
  65: 22, 66: 23, 70: 24,
  256: 25, 257: 26, 258: 27,
  259: 28, 260: 29, 261: 30,
  262: 31, 263: 32, 264: 33,
  265: 34, 266: 35, 267: 36,
  71: 37, 72: 38, 73: 39,
};

function packRecord(record) {
  const specIndex = SPEC_TO_INDEX[record.specId] || 0;
  const flags = 0;
  const byte1 = (specIndex & 0x3f) | ((flags & 0x03) << 6);
  const bestParse = record.wcl?.bestParse ?? 0;
  const medianParse = record.wcl?.medianParse ?? 0;
  const highestKey = record.highestKey ?? 0;
  const recScore = record.recommendation ?? 50;

  const byte2 = Math.min(100, Math.max(0, Math.round(bestParse)));
  const byte3 = Math.min(100, Math.max(0, Math.round(medianParse)));
  const byte4 = Math.min(35, Math.max(0, Math.round(highestKey)));
  const byte5 = 0;
  const byte6 = Math.min(100, Math.max(0, Math.round(recScore)));

  const formatByte = (b) => `\\${b.toString().padStart(3, '0')}`;
  return `"${formatByte(byte1)}${formatByte(byte2)}${formatByte(byte3)}${formatByte(byte4)}${formatByte(byte5)}${formatByte(byte6)}"`;
}

/**
 * Build a Lua database string and compressed Gzip buffer from player records
 */
function buildLuaDataset(playersMap, regionLabel = 'GLOBAL') {
  let enriched = 0, pending = 0, totalUnique = 0;
  const subRegionCounts = {};
  const regionCounts = { US: 0, EU: 0, KR: 0, TW: 0 };
  const regionalBreakdown = { US: {}, EU: {}, KR: {}, TW: {} };
  const playerLines = [];
  const levelCap = getCurrentLevelCap();

  for (const [key, p] of Object.entries(playersMap)) {
    if (!p || typeof p !== 'object') continue;
    if (p.level && p.level < levelCap) continue;
    totalUnique++;
    if (p.enriched) enriched++;
    else pending++;

    const pRegion = String(p.region || 'US').toUpperCase();
    const realmClean = (p.realmSlug || p.realm || '').toLowerCase().replace(/['\s]/g, '-');
    const subReg = getSubRegion(realmClean, pRegion);
    subRegionCounts[subReg] = (subRegionCounts[subReg] || 0) + 1;
    regionCounts[pRegion] = (regionCounts[pRegion] || 0) + 1;
    if (!regionalBreakdown[pRegion]) regionalBreakdown[pRegion] = {};
    regionalBreakdown[pRegion][subReg] = (regionalBreakdown[pRegion][subReg] || 0) + 1;

    // Filter to enriched or active key runners
    const isEnriched = p.enriched || (p.wcl && (p.wcl.bestParse > 0 || p.wcl.medianParse > 0));
    const hasActiveDepth = (p.highestKey && p.highestKey >= 4) || (p.rioScore && p.rioScore >= 800);
    if (!isEnriched && !hasActiveDepth) continue;

    const packed = packRecord(p);
    const pKey = `${p.name.toLowerCase()}-${(p.realmSlug || realmClean).replace(/[^a-z0-9]/g, '')}`;
    playerLines.push(`P["${pKey}"] = ${packed};`);
  }

  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);

  const lines = [
    `-- PartyFinder ${regionLabel} Live Fetched Warcraft Logs Database`,
    '-- Hosted by: https://r2.imongmama.online/',
    `-- Generated: ${now.toISOString()} (${totalUnique} players, ${playerLines.length} active entries)`,
    '-- Deployed via: PartyFinder Cloud Harvester',
    'local _, PF = ...',
    'PF.Data_Live = {',
    `    Region = "${regionLabel}",`,
    `    Generated = ${timestamp},`,
    `    TotalPlayers = ${totalUnique},`,
    `    TotalEntries = ${playerLines.length},`,
    `    EnrichedPlayers = ${enriched},`,
    `    PendingEnrichment = ${pending},`,
    '    SubRegionCounts = {'
  ];

  for (const [sub, count] of Object.entries(subRegionCounts)) {
    lines.push(`        ["${sub}"] = ${count},`);
  }
  lines.push('    },');
  lines.push('    Players = {');
  lines.push('    },');
  lines.push('};');
  lines.push('');
  lines.push('local P = PF.Data_Live.Players;');
  lines.push('');

  // Chunk players into batches of 4,000 to prevent Lua 5.1 constant table overflow
  const BATCH_SIZE = 4000;
  let batchIndex = 0;
  for (let i = 0; i < playerLines.length; i += BATCH_SIZE) {
    batchIndex++;
    lines.push('do');
    lines.push(`    local function _b${batchIndex}()`);
    const chunk = playerLines.slice(i, i + BATCH_SIZE);
    lines.push(chunk.join('\n'));
    lines.push('    end');
    lines.push(`    _b${batchIndex}()`);
    lines.push('end');
    lines.push('');
  }

  lines.push('-- LIVE_INJECTIONS');
  lines.push('');

  const luaContent = lines.join('\n');
  const luaBuffer = Buffer.from(luaContent, 'utf-8');
  const fileSizeBytes = luaBuffer.length;
  const sha256 = crypto.createHash('sha256').update(luaBuffer).digest('hex');

  // Gzip compression for high-speed streaming downloads (3-4 MB instead of 20 MB)
  const gzBuffer = zlib.gzipSync(luaBuffer, { level: 9 });
  const fileSizeGzBytes = gzBuffer.length;
  const sha256Gz = crypto.createHash('sha256').update(gzBuffer).digest('hex');

  return {
    region: regionLabel,
    luaContent,
    gzBuffer,
    fileSizeBytes,
    fileSizeGzBytes,
    sha256,
    sha256Gz,
    stats: {
      totalPlayers: totalUnique,
      totalEntries: playerLines.length,
      enrichedPlayers: enriched,
      pendingEnrichment: pending,
      fileSizeBytes,
      fileSizeMb: (fileSizeBytes / (1024 * 1024)).toFixed(2),
      fileSizeGzBytes,
      fileSizeGzMb: (fileSizeGzBytes / (1024 * 1024)).toFixed(2),
      subRegionCounts,
      regionCounts,
      regionalBreakdown,
    }
  };
}

/**
 * Compile both Global and Regional databases from R2
 */
async function compileDatabase() {
  const regions = ['us', 'eu', 'kr', 'tw'];
  let allPlayers = {};
  let usPlayers = {};

  for (const reg of regions) {
    try {
      const registry = await r2.loadPlayerRegistry(reg);
      if (registry && registry.players) {
        Object.assign(allPlayers, registry.players);
        if (reg === 'us') {
          Object.assign(usPlayers, registry.players);
        }
      }
    } catch (e) {
      console.warn(`[Compiler] No data for region ${reg}: ${e.message}`);
    }
  }

  console.log('[Compiler] Building Global database...');
  const globalDb = buildLuaDataset(allPlayers, 'GLOBAL');

  console.log('[Compiler] Building US regional database...');
  const usDb = buildLuaDataset(usPlayers, 'US');

  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);

  const metaObj = {
    version: '4.1.0',
    generatedAt: now.toISOString(),
    timestamp,
    totalPlayers: globalDb.stats.totalPlayers,
    totalEntries: globalDb.stats.totalEntries,
    enrichedPlayers: globalDb.stats.enrichedPlayers,
    pendingEnrichment: globalDb.stats.pendingEnrichment,
    subRegionCounts: globalDb.stats.subRegionCounts,
    regionCounts: globalDb.stats.regionCounts,
    regionalBreakdown: globalDb.stats.regionalBreakdown,
    season: 'Midnight Season 2 & Liberation of Undermine (Global & Regional)',
    zoneId: 55,
    downloadUrl: 'https://r2.imongmama.online/data/PartyFinder_Data_Live.lua',
    downloadUrlGz: 'https://r2.imongmama.online/data/PartyFinder_Data_Live.lua.gz',
    downloadUrlUS: 'https://r2.imongmama.online/data/PartyFinder_Data_US.lua',
    downloadUrlUSGz: 'https://r2.imongmama.online/data/PartyFinder_Data_US.lua.gz',
    sha256: globalDb.sha256,
    sha256Gz: globalDb.sha256Gz,
    sha256US: usDb.sha256,
    sha256USGz: usDb.sha256Gz,
    fileSizeBytes: globalDb.fileSizeBytes,
    fileSizeGzBytes: globalDb.fileSizeGzBytes,
    fileSizeMb: globalDb.stats.fileSizeMb,
    fileSizeGzMb: globalDb.stats.fileSizeGzMb,
    fileSizeUSMb: usDb.stats.fileSizeMb,
    fileSizeUSGzMb: usDb.stats.fileSizeGzMb,
    deployedVia: 'PartyFinder Cloud Harvester (R2 Direct Stream)',
  };

  return {
    globalDb,
    usDb,
    metaObj,
    metaContent: JSON.stringify(metaObj, null, 2),
  };
}

/**
 * Push lightweight metadata to GitHub (safe: ~2 KB, no 20 MB binary bloat)
 */
async function pushMetaToGitHub(filePath, content, commitMessage) {
  if (!GITHUB_DEPLOY_TOKEN) return null;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  let currentSha = null;
  try {
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${GITHUB_DEPLOY_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'PartyFinder-CloudHarvester',
      },
    });
    if (getRes.ok) {
      const current = await getRes.json();
      currentSha = current.sha;
    }
  } catch (e) {}

  const body = {
    message: commitMessage,
    content: Buffer.from(content).toString('base64'),
    committer: { name: 'PartyFinder Cloud Bot', email: 'harvester@imongmama.online' },
  };
  if (currentSha) body.sha = currentSha;

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_DEPLOY_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'PartyFinder-CloudHarvester',
    },
    body: JSON.stringify(body),
  });

  if (putRes.ok) {
    const resData = await putRes.json();
    return resData.commit?.sha || 'ok';
  }
  return null;
}

async function main() {
  console.log('=== PartyFinder High-Performance CDN Deploy ===');
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    // 1. Compile Global & US Regional databases
    const compiled = await compileDatabase();
    console.log(`[Compiler] Global DB: ${compiled.globalDb.stats.fileSizeMb} MB (Raw) | ${compiled.globalDb.stats.fileSizeGzMb} MB (Gzip)`);
    console.log(`[Compiler] US DB:     ${compiled.usDb.stats.fileSizeMb} MB (Raw) | ${compiled.usDb.stats.fileSizeGzMb} MB (Gzip)`);

    // 2. Upload directly to Cloudflare R2 bucket
    console.log('[R2] Uploading raw and Gzip-compressed databases to R2...');
    await Promise.all([
      r2.putRaw('data/PartyFinder_Data_Live.lua', compiled.globalDb.luaContent, 'text/plain; charset=utf-8'),
      r2.putRaw('data/PartyFinder_Data_Live.lua.gz', compiled.globalDb.gzBuffer, 'application/gzip'),
      r2.putRaw('data/PartyFinder_Data_US.lua', compiled.usDb.luaContent, 'text/plain; charset=utf-8'),
      r2.putRaw('data/PartyFinder_Data_US.lua.gz', compiled.usDb.gzBuffer, 'application/gzip'),
      r2.putRaw('data/partyfinder_meta.json', compiled.metaContent, 'application/json; charset=utf-8'),
    ]);
    console.log('[R2] ✅ All databases (Global, US, Raw, Gzip, Meta) deployed to R2 successfully!');

    // 3. Push lightweight metadata to GitHub (safe, <2 KB, zero git repository bloat)
    if (GITHUB_DEPLOY_TOKEN) {
      const ts = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
      const commitMsg = `chore(meta): sync metadata [${ts}] (${compiled.globalDb.stats.totalPlayers} players)`;
      const metaSha = await pushMetaToGitHub('public/data/partyfinder_meta.json', compiled.metaContent, commitMsg);
      if (metaSha) {
        console.log(`[GitHub] Meta synced to repository: ${metaSha.slice(0, 8)}`);
      }
    }

    // 4. Update Supabase deploy state (non-fatal telemetry)
    try {
      console.log('[Supabase] Updating last_deploy state...');
      await sb.setState('last_deploy', {
        at: new Date().toISOString(),
        stats: compiled.globalDb.stats,
        usStats: compiled.usDb.stats,
        sha256: compiled.globalDb.sha256,
        sha256Gz: compiled.globalDb.sha256Gz,
      });
      await sb.appendLogs([
        { type: 'success', message: `[CDN Deploy] ${compiled.globalDb.stats.totalPlayers} players deployed to R2 (Global ${compiled.globalDb.stats.fileSizeGzMb}MB .gz, US ${compiled.usDb.stats.fileSizeGzMb}MB .gz).`, time: new Date().toTimeString().split(' ')[0], id: Date.now() },
      ]);
      console.log('[Supabase] ✅ State and logs updated.');
    } catch (sbErr) {
      console.warn(`[Supabase] ⚠️ Telemetry update failed: ${sbErr.message || sbErr}`);
    }

  } catch (err) {
    console.error('[FATAL] CDN deploy failed:', err);
    try {
      await sb.appendLogs([
        { type: 'error', message: `[CDN Deploy FAILED] ${err.message}`, time: new Date().toTimeString().split(' ')[0], id: Date.now() },
      ]);
    } catch (_) {}
    process.exit(1);
  }
}

main();
