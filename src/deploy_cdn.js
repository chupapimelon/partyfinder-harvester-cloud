/**
 * deploy_cdn.js — Compile player data to Lua and deploy to Cloudflare Pages via GitHub API
 * Replaces local git.exe workflow with pure HTTP API calls
 * 
 * Triggered hourly via GitHub Actions cron
 */

const crypto = require('crypto');
const r2 = require('./r2_client');
const sb = require('./supabase_client');
const { getCurrentLevelCap } = require('./season_detector');

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

const SUBREGION_MAPPING = {
  'area-52': 'CHI', 'illidan': 'CHI', 'sargeras': 'CHI', 'stormrage': 'CHI',
  'tichondrius': 'LA', 'proudmoore': 'LA', 'kiljaeden': 'LA',
  'frostmourne': 'OCE', 'barthilas': 'OCE',
  'tarren-mill': 'EU-ENG', 'twisting-nether': 'EU-ENG', 'kazzak': 'EU-ENG', 'draenor': 'EU-ENG', 'silvermoon': 'EU-ENG',
  'blackrock': 'EU-GER', 'antonidas': 'EU-GER',
  'hyjal': 'EU-FRA',
  'ragnaros': 'MEX', 'azralon': 'BZL', 'nemesis': 'BZL',
  'azshara': 'KR',
};

function getSubRegion(serverSlug, region = 'US') {
  const clean = String(serverSlug || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
  if (SUBREGION_MAPPING[clean]) return SUBREGION_MAPPING[clean];
  const reg = String(region || 'US').toUpperCase();
  if (reg === 'EU') return 'EU-Oth';
  if (reg === 'KR') return 'KR';
  if (reg === 'TW') return 'TW';
  return 'Oth';
}

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
 * Compile all regions into a single Lua data file
 */
async function compileDatabase() {
  const regions = ['us', 'eu', 'kr', 'tw'];
  let allPlayers = {};

  for (const reg of regions) {
    try {
      const registry = await r2.loadPlayerRegistry(reg);
      if (registry && registry.players) {
        Object.assign(allPlayers, registry.players);
      }
    } catch (e) {
      console.warn(`[Compiler] No data for region ${reg}: ${e.message}`);
    }
  }

  let enriched = 0, pending = 0, totalUnique = 0;
  const subRegionCounts = {};
  const playerLines = [];
  const levelCap = getCurrentLevelCap();

  for (const [key, p] of Object.entries(allPlayers)) {
    if (!p || typeof p !== 'object') continue;
    if (p.level && p.level < levelCap) continue;
    totalUnique++;
    if (p.enriched) enriched++;
    else pending++;

    const realmClean = (p.realmSlug || p.realm || '').toLowerCase().replace(/['\s]/g, '-');
    const subReg = getSubRegion(realmClean, p.region || 'US');
    subRegionCounts[subReg] = (subRegionCounts[subReg] || 0) + 1;

    const packed = packRecord(p);
    const pKey = `${p.name.toLowerCase()}-${(p.realmSlug || realmClean).replace(/[^a-z0-9]/g, '')}`;
    playerLines.push(`        ["${pKey}"] = ${packed},`);
  }

  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);

  const lines = [
    '-- PartyFinder Worldwide Live Fetched Warcraft Logs Database',
    '-- Hosted by: https://imongmama.online/',
    `-- Generated: ${now.toISOString()} (${totalUnique} players)`,
    '-- Deployed via: PartyFinder Cloud Harvester (GitHub Actions)',
    'local _, PF = ...',
    'PF.Data_Live = {',
    '    Region = "GLOBAL",',
    `    Generated = ${timestamp},`,
    `    TotalPlayers = ${totalUnique},`,
    `    EnrichedPlayers = ${enriched},`,
    `    PendingEnrichment = ${pending},`,
    '    SubRegionCounts = {'
  ];

  for (const [sub, count] of Object.entries(subRegionCounts)) {
    lines.push(`        ["${sub}"] = ${count},`);
  }
  lines.push('    },');
  lines.push('    Players = {');

  const luaContent = lines.join('\n') + '\n' + playerLines.join('\n') + '\n    },\n};\n';
  const fileSizeBytes = Buffer.byteLength(luaContent, 'utf-8');
  const sha256 = crypto.createHash('sha256').update(luaContent).digest('hex');

  const metaObj = {
    version: '4.0.0',
    generatedAt: now.toISOString(),
    timestamp,
    totalPlayers: totalUnique,
    totalEntries: playerLines.length,
    enrichedPlayers: enriched,
    pendingEnrichment: pending,
    subRegionCounts,
    season: 'Midnight Season 2 & Liberation of Undermine (Global Worldwide)',
    zoneId: 55,
    downloadUrl: 'https://imongmama.online/data/PartyFinder_Data_Live.lua',
    sha256,
    fileSizeBytes,
    deployedVia: 'PartyFinder Cloud Harvester',
  };

  return {
    luaContent,
    metaContent: JSON.stringify(metaObj, null, 2),
    stats: { totalPlayers: totalUnique, enrichedPlayers: enriched, pendingEnrichment: pending, fileSizeBytes, fileSizeMb: (fileSizeBytes / (1024 * 1024)).toFixed(2) },
  };
}

/**
 * Push a file to GitHub via REST API (replaces git.exe)
 */
async function pushFileToGitHub(filePath, content, commitMessage) {
  if (!GITHUB_DEPLOY_TOKEN) {
    throw new Error('GITHUB_DEPLOY_TOKEN not set');
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  // Get current file SHA (needed for update)
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
      const fileData = await getRes.json();
      currentSha = fileData.sha;
    }
  } catch (e) {
    console.warn(`[GitHub] Could not get SHA for ${filePath}:`, e.message);
  }

  // PUT file content (base64 encoded)
  const body = {
    message: commitMessage,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    committer: {
      name: 'PartyFinder Cloud Harvester',
      email: 'harvester@imongmama.online',
    },
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

  if (!putRes.ok) {
    const errBody = await putRes.text();
    throw new Error(`GitHub PUT failed (${putRes.status}): ${errBody.slice(0, 200)}`);
  }

  const result = await putRes.json();
  return result.commit?.sha || 'unknown';
}

async function main() {
  console.log('=== PartyFinder CDN Deploy ===');
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    // 1. Compile database from R2 data
    console.log('[Compiler] Compiling unified database...');
    const compiled = compileDatabase ? await compileDatabase() : null;
    if (!compiled) throw new Error('Compilation returned null');
    console.log(`[Compiler] Done: ${compiled.stats.totalPlayers} players, ${compiled.stats.fileSizeMb} MB`);

    // 2. Push Lua file to GitHub
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
    const commitMsg = `chore(data): cloud auto-sync [${ts}] (${compiled.stats.totalPlayers} players, ${compiled.stats.enrichedPlayers} enriched)`;

    console.log('[GitHub] Pushing PartyFinder_Data_Live.lua...');
    const luaSha = await pushFileToGitHub('public/data/PartyFinder_Data_Live.lua', compiled.luaContent, commitMsg);
    console.log(`[GitHub] Lua pushed: ${luaSha.slice(0, 8)}`);

    console.log('[GitHub] Pushing partyfinder_meta.json...');
    const metaSha = await pushFileToGitHub('public/data/partyfinder_meta.json', compiled.metaContent, commitMsg);
    console.log(`[GitHub] Meta pushed: ${metaSha.slice(0, 8)}`);

    console.log('[GitHub] ✅ Deploy complete! Cloudflare Pages build triggered.');
    console.log(`[CDN] https://imongmama.online will update in ~60-90s`);

    // 3. Update Supabase deploy state (non-fatal telemetry)
    try {
      console.log('[Supabase] Updating last_deploy state...');
      await sb.setState('last_deploy', {
        at: new Date().toISOString(),
        stats: compiled.stats,
        commitSha: luaSha.slice(0, 8),
      });
      await sb.appendLogs([
        { type: 'success', message: `[CDN Deploy] ${compiled.stats.totalPlayers} players pushed to Cloudflare Pages.`, time: new Date().toTimeString().split(' ')[0], id: Date.now() },
      ]);
      console.log('[Supabase] ✅ State and logs updated.');
    } catch (sbErr) {
      console.warn(`[Supabase] ⚠️ Telemetry update failed: ${sbErr.message || sbErr}. (CDN deployment was already completed successfully)`);
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
