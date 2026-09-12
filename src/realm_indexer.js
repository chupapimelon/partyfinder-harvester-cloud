/**
 * Realm Priority Indexer
 * Provides O(1) realm priority lookups across all 4 regions (US, EU, KR, TW)
 * P1 = Mega Realms (20 in US, 20 in EU, 3 in KR, 3 in TW)
 * P2 = Mid Realms
 * P3 = Low Realms
 */

const fs = require('fs');
const path = require('path');

function cleanRealmSlug(realm) {
  if (!realm) return '';
  return String(realm)
    .trim()
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

let cachedRealmsData = null;
const realmPriorityMap = new Map(); // key: `${region.toLowerCase()}:${slug}` -> priority number (1, 2, or 3)

function loadRealmsData() {
  if (cachedRealmsData) return cachedRealmsData;

  const possiblePaths = [
    path.join(__dirname, '../dashboard/realms.json'),
    path.join(__dirname, 'realms.json'),
    path.join(__dirname, '../../config/realms.json'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        cachedRealmsData = JSON.parse(fs.readFileSync(p, 'utf-8'));
        break;
      } catch (e) {
        console.warn('[RealmIndexer] Error reading', p, e.message);
      }
    }
  }

  if (!cachedRealmsData) {
    console.warn('[RealmIndexer] Warning: realms.json not found in search paths.');
    cachedRealmsData = { US: [], EU: [], KR: [], TW: [] };
  }

  // Populate fast O(1) lookup Map
  for (const [region, realms] of Object.entries(cachedRealmsData)) {
    const regKey = region.toLowerCase();
    if (Array.isArray(realms)) {
      for (const r of realms) {
        const prio = Number(r.priority) || 3;
        if (r.slug) {
          realmPriorityMap.set(`${regKey}:${cleanRealmSlug(r.slug)}`, prio);
          realmPriorityMap.set(`${regKey}:${String(r.slug).toLowerCase()}`, prio);
        }
        if (r.realmSlug) {
          realmPriorityMap.set(`${regKey}:${cleanRealmSlug(r.realmSlug)}`, prio);
        }
        if (r.name) {
          realmPriorityMap.set(`${regKey}:${cleanRealmSlug(r.name)}`, prio);
          realmPriorityMap.set(`${regKey}:${String(r.name).toLowerCase()}`, prio);
        }
      }
    }
  }

  return cachedRealmsData;
}

// Initial load
loadRealmsData();

/**
 * Get priority tier for a given realm (1 = Mega, 2 = Mid, 3 = Low)
 * @param {string} region - 'us', 'eu', 'kr', 'tw'
 * @param {string} realm - realm name or realm slug
 * @returns {number} 1, 2, or 3
 */
function getRealmPriority(region = 'us', realm = '') {
  if (!realm) return 3;
  const regKey = String(region).toLowerCase();
  const slug = cleanRealmSlug(realm);
  return realmPriorityMap.get(`${regKey}:${slug}`) || 3;
}

/**
 * Check if a realm is a Priority 1 Mega Realm
 * @param {string} region
 * @param {string} realm
 * @returns {boolean}
 */
function isMegaRealm(region = 'us', realm = '') {
  return getRealmPriority(region, realm) === 1;
}

/**
 * Get all realms matching a given priority
 * @param {string} region
 * @param {number} priority - 1, 2, or 3
 * @returns {Array}
 */
function getPriorityRealmList(region = 'us', priority = 1) {
  const data = loadRealmsData();
  const regUpper = String(region).toUpperCase();
  const list = data[regUpper] || [];
  return list.filter(r => r.priority === priority);
}

module.exports = {
  cleanRealmSlug,
  getRealmPriority,
  isMegaRealm,
  getPriorityRealmList,
  loadRealmsData,
};
