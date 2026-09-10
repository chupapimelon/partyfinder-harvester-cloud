/**
 * PartyFinder Cloud Studio v2 - Cloud Frontend Controller
 * Strategy 1 Deep Realm Harvester & Role Metric Verification Hub
 * Powered by Cloudflare Pages, Cloudflare R2, and Supabase Realtime
 */

document.addEventListener('DOMContentLoaded', async () => {
  const SUPABASE_URL = 'https://anvkqwbqgqcopsuhhene.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_FdCOqHNEXexN-CgD9Pb9Ag_SLV86t_I';
  const DEFAULT_R2_URL = 'https://r2.imongmama.online';

  let r2BaseUrl = localStorage.getItem('pf_r2_url') || DEFAULT_R2_URL;

  /**
   * Universal R2 fetch helper:
   * 1. First tries relative path (/api/... or /data/...) which uses Cloudflare Pages _redirects proxy (ZERO CORS!)
   * 2. Falls back to direct https://r2.imongmama.online/...
   */
  async function fetchR2(endpoint) {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    // 1. Try relative path through Cloudflare Pages reverse-proxy
    try {
      const res = await fetch(cleanEndpoint, { cache: 'no-cache' });
      if (res.ok) return res;
    } catch (_) {}

    // 2. Fallback to direct custom domain
    const directUrl = `${r2BaseUrl}${cleanEndpoint}`;
    return await fetch(directUrl);
  }

  // Initialize Supabase Client for Realtime
  let supabase = null;
  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
  } catch (err) {
    console.warn('[Supabase] Init warning:', err.message);
  }

  // Navigation Tabs
  const tabBtns = document.querySelectorAll('.nav-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  // Quick Verification Elements
  const quickPlayerInput = document.getElementById('quickPlayerInput');
  const quickRealmSelect = document.getElementById('quickRealmSelect');
  const btnQuickSearch = document.getElementById('btnQuickSearch');
  const verificationResultCard = document.getElementById('verificationResultCard');
  const vcardClassCrest = document.getElementById('vcardClassCrest');
  const vcardName = document.getElementById('vcardName');
  const vcardRealm = document.getElementById('vcardRealm');
  const vcardMeta = document.getElementById('vcardMeta');
  const vcardStatusBadge = document.getElementById('vcardStatusBadge');
  const vcardStatusText = document.getElementById('vcardStatusText');
  const vcardMetricLabel = document.getElementById('vcardMetricLabel');
  const vcardMedianScore = document.getElementById('vcardMedianScore');
  const vcardParsePill = document.getElementById('vcardParsePill');
  const vcardMetricExplanation = document.getElementById('vcardMetricExplanation');
  const vcardRoleVal = document.getElementById('vcardRoleVal');
  const vcardDungeonsCount = document.getElementById('vcardDungeonsCount');
  const vcardRunsCount = document.getElementById('vcardRunsCount');
  const vcardLastSync = document.getElementById('vcardLastSync');
  const vcardRioLink = document.getElementById('vcardRioLink');
  const vcardWclLink = document.getElementById('vcardWclLink');

  // Database Tab Elements
  const dbSearchInput = document.getElementById('dbSearchInput');
  const dbRealmFilter = document.getElementById('dbRealmFilter');
  const dbTierFilter = document.getElementById('dbTierFilter');
  const dbRoleFilter = document.getElementById('dbRoleFilter');
  const dbClassFilter = document.getElementById('dbClassFilter');
  const dbParseFilter = document.getElementById('dbParseFilter');
  const dbStatusFilter = document.getElementById('dbStatusFilter');
  const dbTableBody = document.getElementById('dbTableBody');
  const dbPageInfo = document.getElementById('dbPageInfo');
  const dbCurrentPageNum = document.getElementById('dbCurrentPageNum');
  const btnDbPrevPage = document.getElementById('btnDbPrevPage');
  const btnDbNextPage = document.getElementById('btnDbNextPage');
  const dbTotalCountBadge = document.getElementById('dbTotalCountBadge');
  const btnExportDb = document.getElementById('btnExportDb');

  // Telemetry HUD Elements
  const statTotalPlayers = document.getElementById('statTotalPlayers');
  const statCacheSize = document.getElementById('statCacheSize');
  const statEnrichedPlayers = document.getElementById('statEnrichedPlayers');
  const statEnrichProgress = document.getElementById('statEnrichProgress');
  const statEnrichPercent = document.getElementById('statEnrichPercent');
  const statPendingPlayers = document.getElementById('statPendingPlayers');
  const statWclPoints = document.getElementById('statWclPoints');
  const statWclProgress = document.getElementById('statWclProgress');
  const statWclStatus = document.getElementById('statWclStatus');
  const footerMetaDate = document.getElementById('footerMetaDate');

  // Terminal & Player Stream
  const terminalBody = document.getElementById('terminalBody');
  const chkAutoScroll = document.getElementById('chkAutoScroll');
  const btnClearLog = document.getElementById('btnClearLog');
  const btnCopyLog = document.getElementById('btnCopyLog');
  const playerStream = document.getElementById('playerStream');
  const livePlayerCounter = document.getElementById('livePlayerCounter');

  // Export Button link
  if (btnExportDb) {
    btnExportDb.addEventListener('click', () => {
      window.open(`${r2BaseUrl}/data/rio_players_us.json`, '_blank');
    });
  }

  let currentMeta = null;
  let currentPage = 1;
  let totalPages = 2635;
  let currentLoadedPagePlayers = [];
  let isSearchActive = false;
  let cachedSearchBucket = null;
  let cachedSearchBucketChar = '';

  // Class Color Map
  const CLASS_COLORS = {
    'Death Knight': '#C41E3A',
    'Demon Hunter': '#A330C9',
    'Druid': '#FF7C0A',
    'Evoker': '#33937F',
    'Hunter': '#AAD372',
    'Mage': '#3FC7EB',
    'Monk': '#00FF98',
    'Paladin': '#F48CBA',
    'Priest': '#FFFFFF',
    'Rogue': '#FFF468',
    'Shaman': '#0070DD',
    'Warlock': '#8788EE',
    'Warrior': '#C69B6D'
  };

  function cleanRealmSlug(realm) {
    if (!realm) return '';
    return String(realm)
      .trim()
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // --------------------------------------------------------------------------
  // 1. Tab Switching
  // --------------------------------------------------------------------------
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabPanes.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(targetId);
      if (pane) pane.classList.add('active');
      if (targetId === 'tab-analytics' && rawRealmsData) {
        renderAnalyticsGrid(rawRealmsData);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Logging & Console
  // --------------------------------------------------------------------------
  const seenLogIds = new Set();

  function appendLog(level, msg, timestamp) {
    if (!terminalBody) return;
    const ts = timestamp || new Date().toTimeString().split(' ')[0];
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;

    const tagClass = level === 'success' ? 'tag-success' : (level === 'warn' ? 'tag-warn' : (level === 'error' ? 'tag-error' : 'tag-info'));
    const tagText = level.toUpperCase();

    line.innerHTML = `
      <span class="log-ts">[${ts}]</span>
      <span class="log-tag ${tagClass}">${tagText}</span>
      <span class="log-msg">${escapeHtml(msg)}</span>
    `;

    terminalBody.appendChild(line);
    if (chkAutoScroll && chkAutoScroll.checked) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
    }
  }

  if (btnClearLog) {
    btnClearLog.addEventListener('click', () => {
      terminalBody.innerHTML = '';
    });
  }

  if (btnCopyLog) {
    btnCopyLog.addEventListener('click', () => {
      const text = Array.from(terminalBody.querySelectorAll('.log-line'))
        .map(l => l.innerText)
        .join('\n');
      navigator.clipboard.writeText(text);
      appendLog('info', 'Console logs copied to clipboard.');
    });
  }

  // --------------------------------------------------------------------------
  // 3. Load Realms Data (realms.json)
  // --------------------------------------------------------------------------
  let rawRealmsData = null;

  function getRealmInfo(realmName) {
    if (!rawRealmsData || !realmName) return null;
    const clean = realmName.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const reg of ['US', 'EU', 'KR', 'TW']) {
      const list = rawRealmsData[reg] || [];
      const match = list.find(r =>
        r.name.toLowerCase().replace(/[^a-z0-9]/g, '') === clean ||
        r.slug.toLowerCase().replace(/[^a-z0-9]/g, '') === clean
      );
      if (match) return match;
    }
    return null;
  }

  function getRealmPriority(realmName) {
    const info = getRealmInfo(realmName);
    return info ? info.priority : 3;
  }

  async function loadRealms() {
    try {
      const res = await fetch('realms.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rawRealmsData = await res.json();

      const usRealms = rawRealmsData['US'] || [];
      if (quickRealmSelect) {
        quickRealmSelect.innerHTML = '<option value="">All Realms (Auto-Detect)</option>';
        usRealms.forEach(r => {
          const opt = document.createElement('option');
          opt.value = r.name;
          opt.textContent = `${r.name} (${r.priority === 1 ? '👑 Mega' : (r.priority === 2 ? '🔷 Mid' : '◽ Low')})`;
          quickRealmSelect.appendChild(opt);
        });
      }

      if (dbRealmFilter) {
        dbRealmFilter.innerHTML = '<option value="all">All Realms</option>';
        usRealms.forEach(r => {
          const opt = document.createElement('option');
          opt.value = r.name;
          opt.textContent = r.name;
          dbRealmFilter.appendChild(opt);
        });
      }

      renderAnalyticsGrid(rawRealmsData);
      appendLog('success', 'Realms database loaded (US • EU • KR • TW).');
    } catch (e) {
      appendLog('warn', `realms.json offline (${e.message}). Falling back to dynamic parsing.`);
    }
  }

  // --------------------------------------------------------------------------
  // 4. Load Player Registry from R2 (Paginated API)
  // --------------------------------------------------------------------------
  async function loadMeta() {
    try {
      const res = await fetchR2('/api/us/meta.json');
      if (!res.ok) throw new Error(`R2 meta returned HTTP ${res.status}`);
      currentMeta = await res.json();

      totalPages = currentMeta.totalPages || 2635;
      updateTelemetryFromMeta(currentMeta);
      appendLog('success', `Connected to R2 Storage: ${currentMeta.totalPlayers.toLocaleString()} players across ${totalPages} pages.`);
    } catch (err) {
      console.warn('Meta fetch warning:', err);
      appendLog('info', `R2 endpoint: ${r2BaseUrl}`);
    }
  }

  function updateTelemetryFromMeta(meta) {
    const total = meta.totalPlayers || 131723;
    const enriched = meta.enrichedPlayers || 0;
    const pending = meta.pendingEnrichment || (total - enriched);
    const pct = total > 0 ? ((enriched / total) * 100).toFixed(1) : '0.0';

    if (statTotalPlayers) statTotalPlayers.textContent = total.toLocaleString();
    if (statCacheSize) statCacheSize.textContent = `${total.toLocaleString()} of 494,116 US Players (${((total / 494116) * 100).toFixed(2)}%)`;
    if (statEnrichedPlayers) statEnrichedPlayers.textContent = enriched.toLocaleString();
    if (statPendingPlayers) statPendingPlayers.textContent = pending.toLocaleString();
    if (statEnrichProgress) statEnrichProgress.style.width = `${pct}%`;
    if (statEnrichPercent) statEnrichPercent.textContent = `${pct}% ENRICHED`;
    if (dbTotalCountBadge) dbTotalCountBadge.textContent = `${total.toLocaleString()} Players Recorded`;
    if (footerMetaDate) footerMetaDate.textContent = `Database: ${total.toLocaleString()} Players Stored in R2`;
  }

  async function loadPage(pageNum) {
    if (pageNum < 1) pageNum = 1;
    if (pageNum > totalPages) pageNum = totalPages;
    currentPage = pageNum;

    const pageStr = String(pageNum).padStart(4, '0');
    if (dbTableBody) {
      dbTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 30px;"><div class="spinner-dot" style="margin: 0 auto 10px;"></div>Loading page ${pageNum} from Cloudflare R2...</td></tr>`;
    }

    try {
      const res = await fetchR2(`/api/us/page_${pageStr}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentLoadedPagePlayers = data.players || [];
      renderDatabaseTable(currentLoadedPagePlayers);

      if (dbCurrentPageNum) dbCurrentPageNum.textContent = `Page ${currentPage} of ${totalPages}`;
      if (dbPageInfo) dbPageInfo.textContent = `Showing ${(currentPage - 1) * 50 + 1} to ${Math.min(currentPage * 50, currentMeta?.totalPlayers || 131723)} of ${(currentMeta?.totalPlayers || 131723).toLocaleString()} entries`;
      if (btnDbPrevPage) btnDbPrevPage.disabled = currentPage <= 1;
      if (btnDbNextPage) btnDbNextPage.disabled = currentPage >= totalPages;
    } catch (err) {
      if (dbTableBody) {
        dbTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #ef4444; padding: 30px;">Failed to load page from R2: ${escapeHtml(err.message)}<br><small style="color: var(--text-muted); margin-top: 6px; display: inline-block;">Make sure public access or custom domain <code>${r2BaseUrl}</code> is enabled in your Cloudflare R2 settings.</small></td></tr>`;
      }
    }
  }

  if (btnDbPrevPage) {
    btnDbPrevPage.addEventListener('click', () => {
      if (currentPage > 1) loadPage(currentPage - 1);
    });
  }

  if (btnDbNextPage) {
    btnDbNextPage.addEventListener('click', () => {
      if (currentPage < totalPages) loadPage(currentPage + 1);
    });
  }

  // --------------------------------------------------------------------------
  // 5. Search in Database (Alphabetical R2 Buckets)
  // --------------------------------------------------------------------------
  let searchDebounceTimer = null;

  if (dbSearchInput) {
    dbSearchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(performDatabaseSearch, 250);
    });
  }

  [dbRealmFilter, dbTierFilter, dbRoleFilter, dbClassFilter, dbParseFilter, dbStatusFilter].forEach(filterEl => {
    if (filterEl) {
      filterEl.addEventListener('change', () => {
        if (isSearchActive && cachedSearchBucket) {
          applyFiltersToSearchBucket();
        } else {
          renderDatabaseTable(currentLoadedPagePlayers);
        }
      });
    }
  });

  async function performDatabaseSearch() {
    const query = dbSearchInput ? dbSearchInput.value.trim().toLowerCase() : '';
    if (!query) {
      isSearchActive = false;
      renderDatabaseTable(currentLoadedPagePlayers);
      if (dbCurrentPageNum) dbCurrentPageNum.textContent = `Page ${currentPage} of ${totalPages}`;
      if (btnDbPrevPage) btnDbPrevPage.disabled = currentPage <= 1;
      if (btnDbNextPage) btnDbNextPage.disabled = currentPage >= totalPages;
      return;
    }

    isSearchActive = true;
    const firstChar = query[0];
    const bucket = /[a-z]/.test(firstChar) ? firstChar : 'misc';

    if (cachedSearchBucketChar !== bucket) {
      if (dbTableBody) {
        dbTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 30px;"><div class="spinner-dot" style="margin: 0 auto 10px;"></div>Querying R2 search index [${bucket.toUpperCase()}]...</td></tr>`;
      }
      try {
        const res = await fetchR2(`/api/us/search_${bucket}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cachedSearchBucket = await res.json();
        cachedSearchBucketChar = bucket;
      } catch (err) {
        if (dbTableBody) {
          dbTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 20px;">Search index loading error: ${escapeHtml(err.message)}</td></tr>`;
        }
        return;
      }
    }

    applyFiltersToSearchBucket();
  }

  function applyFiltersToSearchBucket() {
    if (!Array.isArray(cachedSearchBucket)) return;
    const query = dbSearchInput ? dbSearchInput.value.trim().toLowerCase() : '';
    const realmVal = dbRealmFilter ? dbRealmFilter.value : 'all';
    const tierVal = dbTierFilter ? dbTierFilter.value : 'all';
    const roleVal = dbRoleFilter ? dbRoleFilter.value : 'all';
    const classVal = dbClassFilter ? dbClassFilter.value : 'all';
    const parseVal = dbParseFilter ? parseFloat(dbParseFilter.value) || 0 : 0;
    const statusVal = dbStatusFilter ? dbStatusFilter.value : 'all';

    const filtered = cachedSearchBucket.filter(p => {
      if (query && !p.name.toLowerCase().includes(query)) return false;
      if (realmVal !== 'all' && p.realm !== realmVal) return false;
      if (tierVal !== 'all') {
        const pTier = getRealmPriority(p.realm);
        if (String(pTier) !== tierVal) return false;
      }
      if (roleVal !== 'all' && p.role !== roleVal) return false;
      if (classVal !== 'all' && p.class !== classVal) return false;
      const median = p.medianParse || p.median || 0;
      if (parseVal > 0 && median < parseVal) return false;
      if (statusVal === 'enriched' && (!p.enriched || p.unlogged)) return false;
      if (statusVal === 'unlogged' && !p.unlogged) return false;
      if (statusVal === 'discovered' && p.enriched) return false;
      return true;
    });

    renderDatabaseTable(filtered.slice(0, 100));
    if (dbPageInfo) dbPageInfo.textContent = `Found ${filtered.length.toLocaleString()} matching characters (showing top 100)`;
    if (dbCurrentPageNum) dbCurrentPageNum.textContent = `Search Mode`;
    if (btnDbPrevPage) btnDbPrevPage.disabled = true;
    if (btnDbNextPage) btnDbNextPage.disabled = true;
  }

  function renderDatabaseTable(players) {
    if (!dbTableBody) return;
    dbTableBody.innerHTML = '';
    if (!players || players.length === 0) {
      dbTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 30px;">No players matching filter criteria.</td></tr>`;
      return;
    }

    players.forEach(p => {
      const tr = document.createElement('tr');
      const classColor = CLASS_COLORS[p.class] || '#fff';
      const roleIcon = p.role === 'Tank' ? '🛡️' : (p.role === 'Healer' ? '💚' : '⚔️');
      const pTier = getRealmPriority(p.realm);
      let tierBadge = `<span class="tier-pill-micro pill-p3-micro">◽ Low</span>`;
      if (pTier === 1) tierBadge = `<span class="tier-pill-micro pill-p1-micro">👑 Mega</span>`;
      else if (pTier === 2) tierBadge = `<span class="tier-pill-micro pill-p2-micro">🔷 Mid</span>`;

      const rioDisplay = p.rioScore ? `<strong style="color: var(--amber); font-family: var(--font-mono); font-size: 13px;">${p.rioScore.toFixed(1)}</strong>` : '<span style="color: var(--text-dim);">-</span>';

      const median = p.medianParse || p.median || 0;
      let parseDisplay = '';
      if (p.enriched && !p.unlogged && median > 0) {
        parseDisplay = `<span class="parse-pill" id="pill-${p.name}" style="display: inline-block;">${median.toFixed(1)}%</span>`;
      } else if (p.unlogged) {
        parseDisplay = `<span class="badge badge-soft-warning">Unlogged</span>`;
      } else {
        parseDisplay = `<span class="badge badge-soft-info">Queued</span>`;
      }

      let statusBadge = `<span class="badge badge-soft-info">Discovered</span>`;
      if (p.enriched && !p.unlogged && median > 0) {
        statusBadge = `<span class="badge badge-emerald">Enriched</span>`;
      } else if (p.unlogged) {
        statusBadge = `<span class="badge badge-soft-warning">Unlogged</span>`;
      }

      const realmSlug = cleanRealmSlug(p.realmSlug || p.realm);
      const reg = (p.region || 'US').toLowerCase();
      const rioUrl = `https://raider.io/characters/${reg}/${realmSlug}/${encodeURIComponent(p.name)}`;
      const wclUrl = `https://www.warcraftlogs.com/character/${reg}/${realmSlug}/${encodeURIComponent(p.name)}`;

      tr.innerHTML = `
        <td><strong style="color: ${classColor};">${escapeHtml(p.name)}</strong></td>
        <td>
          <div class="table-realm-cell">
            <span>${escapeHtml(p.realm)}</span>
            ${tierBadge}
          </div>
        </td>
        <td><span style="color: ${classColor}; font-weight: 600;">${escapeHtml(p.spec || '')} ${escapeHtml(p.class || '')}</span></td>
        <td>${roleIcon} ${escapeHtml(p.role || '')}</td>
        <td>${rioDisplay}</td>
        <td>${parseDisplay}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="table-actions-cell">
            <a href="${rioUrl}" target="_blank" class="btn-brand-action action-rio" title="View on Raider.IO">
              <img src="assets/raiderio_logo.png" alt="Raider.IO">
            </a>
            <a href="${wclUrl}" target="_blank" class="btn-brand-action action-wcl" title="View on Warcraft Logs">
              <img src="assets/warcraftlogs_logo.png" alt="Warcraft Logs">
            </a>
          </div>
        </td>
      `;
      dbTableBody.appendChild(tr);

      if (p.enriched && median > 0) {
        const pill = tr.querySelector(`#pill-${CSS.escape(p.name)}`);
        if (pill) applyParsePill(pill, median);
      }
    });
  }

  function applyParsePill(pillElement, score) {
    if (!pillElement) return;
    pillElement.className = 'parse-pill';
    const display = typeof score === 'number' ? score.toFixed(1) : score;
    if (score >= 100) {
      pillElement.classList.add('pill-100');
      pillElement.textContent = `Celestial ${display}`;
    } else if (score >= 99) {
      pillElement.classList.add('pill-99');
      pillElement.textContent = `Rank ${display}`;
    } else if (score >= 95) {
      pillElement.classList.add('pill-legendary');
      pillElement.textContent = `Legendary ${display}`;
    } else if (score >= 75) {
      pillElement.classList.add('pill-epic');
      pillElement.textContent = `Epic ${display}`;
    } else if (score >= 50) {
      pillElement.classList.add('pill-rare');
      pillElement.textContent = `Rare ${display}`;
    } else if (score >= 25) {
      pillElement.classList.add('pill-uncommon');
      pillElement.textContent = `Uncommon ${display}`;
    } else {
      pillElement.classList.add('pill-common');
      pillElement.textContent = `Common ${display}`;
    }
  }

  // --------------------------------------------------------------------------
  // 6. Quick Player Verification
  // --------------------------------------------------------------------------
  if (btnQuickSearch && quickPlayerInput) {
    btnQuickSearch.addEventListener('click', performQuickVerification);
    quickPlayerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performQuickVerification();
    });
  }

  async function performQuickVerification() {
    let rawInput = quickPlayerInput.value.trim();
    if (!rawInput) {
      alert('Please enter a character name (e.g. Gregxo or Gregxo-Illidan)');
      return;
    }

    let charName = rawInput;
    let selectedRealm = quickRealmSelect ? quickRealmSelect.value : '';

    if (rawInput.includes('-')) {
      const parts = rawInput.split('-');
      charName = parts[0].trim();
      selectedRealm = parts[1].trim();
    }

    appendLog('info', `Looking up [${charName}] in cloud R2 index...`);

    const firstChar = charName[0].toLowerCase();
    const bucket = /[a-z]/.test(firstChar) ? firstChar : 'misc';

    let found = null;
    try {
      const res = await fetchR2(`/api/us/search_${bucket}.json`);
      if (res.ok) {
        const bucketData = await res.json();
        found = bucketData.find(p =>
          p.name.toLowerCase() === charName.toLowerCase() &&
          (!selectedRealm || p.realm.toLowerCase() === selectedRealm.toLowerCase())
        );
      }
    } catch (err) {
      console.warn('Quick search lookup error:', err);
    }

    if (verificationResultCard) verificationResultCard.style.display = 'block';

    if (found) {
      if (vcardStatusBadge) vcardStatusBadge.className = 'vcard-status-pill verified';
      if (vcardStatusText) vcardStatusText.textContent = (found.enriched && !found.unlogged && (found.medianParse || 0) > 0) ? 'WCL ENRICHED & STORED' : (found.unlogged ? 'RAIDER.IO BASELINE (UNLOGGED)' : 'RAIDER.IO TRACKED (QUEUED)');
      if (vcardName) vcardName.textContent = found.name;
      if (vcardRealm) vcardRealm.textContent = `— ${found.realm} (${found.region || 'US'})`;
      if (vcardMeta) vcardMeta.textContent = `${found.spec || ''} ${found.class || ''} • ${found.rioScore ? found.rioScore.toFixed(1) + ' Raider.IO Score' : 'Season 2 Mythic+'}`;

      const classColor = CLASS_COLORS[found.class] || '#fff';
      if (vcardClassCrest) {
        vcardClassCrest.style.borderColor = classColor;
        vcardClassCrest.style.color = classColor;
        vcardClassCrest.style.boxShadow = `0 0 10px ${classColor}40`;
        vcardClassCrest.textContent = (found.class || 'C').split(' ').map(w => w[0]).join('');
      }

      let metricTitle = '';
      let roleIcon = '';
      if (found.role === 'Tank') {
        metricTitle = '⚡ TANK: SPEED MEDIAN PERF. AVG';
        roleIcon = '🛡️ Tank';
      } else if (found.role === 'Healer') {
        metricTitle = '💚 HEALER: HEALING MEDIAN PERF. AVG';
        roleIcon = '💚 Healer';
      } else {
        metricTitle = '⚔️ DPS: DAMAGE MEDIAN PERF. AVG';
        roleIcon = '⚔️ DPS';
      }

      if (vcardMetricLabel) vcardMetricLabel.innerHTML = metricTitle;
      const median = found.medianParse || 0;
      if (found.enriched && median > 0) {
        if (vcardMedianScore) vcardMedianScore.textContent = median.toFixed(1);
        if (vcardMetricExplanation) vcardMetricExplanation.innerHTML = `Evaluated across Season Dungeons using authentic Warcraft Logs clearance metrics.`;
        if (vcardParsePill) applyParsePill(vcardParsePill, median);
      } else if (found.unlogged) {
        if (vcardMedianScore) vcardMedianScore.textContent = (found.rioScore || 0).toFixed(1);
        if (vcardParsePill) {
          vcardParsePill.className = 'parse-pill pill-rare';
          vcardParsePill.textContent = 'IO Baseline';
        }
        if (vcardMetricExplanation) vcardMetricExplanation.innerHTML = `High-key pusher (${found.rioScore} M+ IO) with no public Warcraft Logs parses. Baseline derived from authentic Raider.IO runs.`;
      } else {
        if (vcardMedianScore) vcardMedianScore.textContent = (found.rioScore || 0).toFixed(1);
        if (vcardParsePill) {
          vcardParsePill.className = 'parse-pill pill-uncommon';
          vcardParsePill.textContent = 'RIO Tracked';
        }
        if (vcardMetricExplanation) vcardMetricExplanation.innerHTML = `Tracked in cloud registry. Queued for automatic WCL GraphQL combat parse lookup in an upcoming 5-minute tick.`;
      }

      if (vcardRoleVal) vcardRoleVal.textContent = roleIcon;
      if (vcardDungeonsCount) vcardDungeonsCount.textContent = `8 / 8 Active`;
      if (vcardRunsCount) vcardRunsCount.textContent = `${found.highestKey ? '+' + found.highestKey + ' Key' : 'Active Pusher'}`;
      if (vcardLastSync) vcardLastSync.textContent = 'Cloudflare R2';

      const realmSlug = cleanRealmSlug(found.realmSlug || found.realm);
      if (vcardRioLink) vcardRioLink.href = `https://raider.io/characters/us/${realmSlug}/${encodeURIComponent(found.name)}`;
      if (vcardWclLink) vcardWclLink.href = `https://www.warcraftlogs.com/character/us/${realmSlug}/${encodeURIComponent(found.name)}`;

      appendLog('success', `Found character in R2: ${found.name}-${found.realm} • ${found.role} • R.IO: ${found.rioScore}`);
    } else {
      if (vcardStatusBadge) {
        vcardStatusBadge.className = 'vcard-status-pill unverified';
        vcardStatusBadge.textContent = 'NOT IN DATABASE';
      }
      if (vcardName) vcardName.textContent = charName;
      if (vcardRealm) vcardRealm.textContent = selectedRealm ? `— ${selectedRealm}` : '— Realm Unknown';
      if (vcardMeta) vcardMeta.textContent = 'No recorded Mythic+ run in current harvested cache';
      if (vcardClassCrest) {
        vcardClassCrest.style.borderColor = '#64748b';
        vcardClassCrest.style.color = '#64748b';
        vcardClassCrest.textContent = '?';
      }

      if (vcardMetricLabel) vcardMetricLabel.innerHTML = '⚠️ NO RECORD FOUND';
      if (vcardMedianScore) vcardMedianScore.textContent = '0.0';
      if (vcardParsePill) {
        vcardParsePill.className = 'parse-pill pill-common';
        vcardParsePill.textContent = 'UNVERIFIED';
      }
      if (vcardMetricExplanation) vcardMetricExplanation.innerHTML = 'This player has not appeared in current scanned leaderboards. The autonomous engine sweeps additional leaderboard pages continuously.';
      if (vcardRoleVal) vcardRoleVal.textContent = 'Unknown';
      if (vcardDungeonsCount) vcardDungeonsCount.textContent = '0';
      if (vcardRunsCount) vcardRunsCount.textContent = '0 Runs';
      if (vcardLastSync) vcardLastSync.textContent = 'Never';

      const realmSlug = cleanRealmSlug(selectedRealm || 'illidan');
      if (vcardRioLink) vcardRioLink.href = `https://raider.io/characters/us/${realmSlug}/${encodeURIComponent(charName)}`;
      if (vcardWclLink) vcardWclLink.href = `https://www.warcraftlogs.com/character/us/${realmSlug}/${encodeURIComponent(charName)}`;

      appendLog('warn', `Character [${charName}] not found in current R2 index.`);
    }
  }

  // --------------------------------------------------------------------------
  // 7. Live Stream Feed
  // --------------------------------------------------------------------------
  function streamPlayerCard(player) {
    if (!playerStream) return;
    const card = document.createElement('div');
    card.className = 'player-card';

    const classColor = CLASS_COLORS[player.class] || '#ffffff';
    const roleIcon = player.role === 'Tank' ? '🛡️' : (player.role === 'Healer' ? '💚' : '⚔️');
    const isEnriched = !!player.enriched;
    const median = player.medianParse || player.median || 0;

    let rightHtml = '';
    if (isEnriched && median > 0) {
      const pillClass = median >= 99 ? 'pill-legendary' : (median >= 95 ? 'pill-epic' : (median >= 75 ? 'pill-rare' : 'pill-common'));
      rightHtml = `
        <span class="p-metric-tag" style="background: rgba(56, 189, 248, 0.15); color: var(--cyan); border-color: rgba(56, 189, 248, 0.4);">${player.role === 'Tank' ? 'SPEED' : (player.role === 'Healer' ? 'HPS' : 'DPS')}</span>
        <span class="parse-pill ${pillClass}">${median.toFixed(1)}%</span>
      `;
    } else {
      rightHtml = `
        <span class="p-metric-tag" style="background: rgba(245, 158, 11, 0.15); color: var(--amber); border-color: rgba(245, 158, 11, 0.4);">IO SCORE</span>
        <span class="parse-pill" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border-color: rgba(245, 158, 11, 0.5);">${player.rioScore || '—'}</span>
      `;
    }

    card.innerHTML = `
      <div class="p-left">
        <span class="p-role-badge">${roleIcon}</span>
        <div class="p-info">
          <div class="p-name-row">
            <span class="p-name" style="color: ${classColor};">${escapeHtml(player.name)}</span>
            <span class="p-realm">— ${escapeHtml(player.realm)}</span>
          </div>
          <span class="p-spec">${escapeHtml(player.spec || '')} ${escapeHtml(player.class || '')} • ${isEnriched ? 'Combat Enriched' : 'Discovered Pusher'}</span>
        </div>
      </div>
      <div class="p-right">
        ${rightHtml}
      </div>
    `;

    const empty = document.getElementById('streamEmptyState');
    if (empty) empty.remove();

    playerStream.insertBefore(card, playerStream.firstChild);
    if (playerStream.children.length > 40) {
      playerStream.removeChild(playerStream.lastChild);
    }
  }

  // --------------------------------------------------------------------------
  // 8. Supabase Realtime State Subscription
  // --------------------------------------------------------------------------
  async function initSupabaseState() {
    if (!supabase) return;

    try {
      // 1. Initial State Fetch
      const { data, error } = await supabase
        .from('harvester_state')
        .select('key, value');

      if (!error && Array.isArray(data)) {
        data.forEach(row => {
          if (row.key === 'progress') handleProgressUpdate(row.value);
          if (row.key === 'recent_logs') handleLogsUpdate(row.value);
          if (row.key === 'recent_discovered') handleDiscoveredUpdate(row.value);
          if (row.key === 'wcl_rate_limit') handleRateLimitUpdate(row.value);
        });
      }

      // 2. Realtime Subscription
      supabase
        .channel('harvester_live_updates')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'harvester_state'
        }, (payload) => {
          const row = payload.new;
          if (!row || !row.key) return;
          if (row.key === 'progress') handleProgressUpdate(row.value);
          if (row.key === 'recent_logs') handleLogsUpdate(row.value);
          if (row.key === 'recent_discovered') handleDiscoveredUpdate(row.value);
          if (row.key === 'wcl_rate_limit') handleRateLimitUpdate(row.value);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            appendLog('success', 'Supabase Realtime active: Subscribed to harvester state channel.');
            if (livePlayerCounter) livePlayerCounter.textContent = 'Realtime Connected';
          }
        });

    } catch (err) {
      console.warn('Supabase state sync error:', err);
    }
  }

  function handleProgressUpdate(prog) {
    if (!prog) return;
    const us = prog.us || prog;
    if (!us) return;

    if (us.totalPlayers && statTotalPlayers) statTotalPlayers.textContent = us.totalPlayers.toLocaleString();
    if (us.enrichedPlayers && statEnrichedPlayers) statEnrichedPlayers.textContent = us.enrichedPlayers.toLocaleString();
    if (us.pendingEnrichment !== undefined && statPendingPlayers) statPendingPlayers.textContent = us.pendingEnrichment.toLocaleString();

    if (us.totalPlayers && us.enrichedPlayers) {
      const pct = ((us.enrichedPlayers / us.totalPlayers) * 100).toFixed(1);
      if (statEnrichProgress) statEnrichProgress.style.width = `${pct}%`;
      if (statEnrichPercent) statEnrichPercent.textContent = `${pct}% ENRICHED`;
    }

    if (us.lastTickAt) {
      const d = new Date(us.lastTickAt);
      appendLog('info', `Cloud Tick recorded: Mode [${us.lastTickMode || 'cron'}] • ${d.toLocaleTimeString()}`);
    }
  }

  function handleLogsUpdate(logs) {
    if (!Array.isArray(logs)) return;
    logs.forEach(l => {
      const logKey = `${l.time}-${l.message}`;
      if (!seenLogIds.has(logKey)) {
        seenLogIds.add(logKey);
        appendLog(l.type || 'info', l.message, l.time);
      }
    });
  }

  function handleDiscoveredUpdate(players) {
    if (!Array.isArray(players)) return;
    players.forEach(p => streamPlayerCard(p));
  }

  function handleRateLimitUpdate(rl) {
    if (!rl) return;
    const pts = rl.pointsRemaining ?? 3600;
    const limit = rl.limitPerHour ?? 3600;
    if (statWclPoints) statWclPoints.textContent = pts.toLocaleString();
    if (statWclProgress) {
      const pct = Math.min(100, Math.max(0, (pts / limit) * 100));
      statWclProgress.style.width = `${pct}%`;
    }
    if (statWclStatus) {
      const used = Math.max(0, limit - pts);
      statWclStatus.textContent = `${used.toLocaleString()} / ${limit.toLocaleString()} pts/hr used`;
    }
  }

  // --------------------------------------------------------------------------
  // 9. Analytics Matrix Rendering
  // --------------------------------------------------------------------------
  function renderAnalyticsGrid(realmsData) {
    const analyticsMatrixBody = document.getElementById('analyticsMatrixBody');
    const analyticsMatrixFoot = document.getElementById('analyticsMatrixFoot');
    if (!analyticsMatrixBody || !realmsData) return;

    const regions = [
      { code: 'US', name: 'Americas & Oceania', dcs: 'Chicago, LA, Sydney, Sao Paulo', jurisdictions: ['US', 'OCE', 'BRA'] },
      { code: 'EU', name: 'Europe', dcs: 'Frankfurt, Paris, London', jurisdictions: ['EU-ENG', 'EU-GER', 'EU-FRA', 'EU-RUS'] },
      { code: 'KR', name: 'Korea', dcs: 'Seoul', jurisdictions: ['KR'] },
      { code: 'TW', name: 'Taiwan & Global', dcs: 'Taipei', jurisdictions: ['TW'] }
    ];

    let rowsHtml = '';
    regions.forEach(r => {
      const list = realmsData[r.code] || [];
      const totalRealms = list.length;
      const p1Count = list.filter(x => x.priority === 1).length;
      const p2Count = list.filter(x => x.priority === 2).length;
      const p3Count = list.filter(x => x.priority === 3).length;
      const census = list.reduce((s, x) => s + (x.mplusPop || 0), 0);

      const isUs = r.code === 'US';
      const harvested = isUs ? (currentMeta?.totalPlayers || 131723) : 0;
      const enriched = isUs ? (currentMeta?.enrichedPlayers || 30) : 0;

      const scrapePct = census > 0 ? ((harvested / census) * 100).toFixed(1) : '0.0';
      const enrichPct = harvested > 0 ? ((enriched / harvested) * 100).toFixed(1) : '0.0';

      rowsHtml += `
        <tr>
          <td>
            <div class="matrix-region-cell">
              <span class="matrix-region-tag tag-${r.code.toLowerCase()}">${r.code}</span>
              <div class="matrix-region-details">
                <strong class="matrix-region-name">${r.name}</strong>
                <div class="matrix-region-meta-row">
                  <span class="matrix-dcs-label">${r.dcs}</span>
                </div>
              </div>
            </div>
          </td>
          <td>
            <strong style="color: var(--cyan); font-family: var(--font-number);">${totalRealms} Realms</strong>
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">👑 ${p1Count} Mega • 🔷 ${p2Count} Mid • ◽ ${p3Count} Low</div>
          </td>
          <td><strong style="font-family: var(--font-mono); color: #fff;">${census.toLocaleString()}</strong></td>
          <td>
            <div class="matrix-progress-cell">
              <div style="display: flex; justify-content: space-between; font-size: 10px; font-family: var(--font-mono);">
                <span style="color: #f59e0b; font-weight: 700;">${harvested.toLocaleString()}</span>
                <span style="color: var(--text-muted);">${scrapePct}%</span>
              </div>
              <div class="matrix-progress-bar">
                <div class="matrix-bar-fill-rio" style="width: ${scrapePct}%;"></div>
              </div>
            </div>
          </td>
          <td>
            <div class="matrix-progress-cell">
              <div style="display: flex; justify-content: space-between; font-size: 10px; font-family: var(--font-mono);">
                <span style="color: #38bdf8; font-weight: 700;">${enriched.toLocaleString()}</span>
                <span style="color: var(--text-muted);">${enrichPct}%</span>
              </div>
              <div class="matrix-progress-bar">
                <div class="matrix-bar-fill-wcl" style="width: ${enrichPct}%;"></div>
              </div>
            </div>
          </td>
          <td>${isUs ? '<span class="badge badge-emerald">Active Cloud Engine</span>' : '<span class="badge badge-soft-warning">Standby</span>'}</td>
        </tr>
      `;
    });

    analyticsMatrixBody.innerHTML = rowsHtml;
  }

  // --------------------------------------------------------------------------
  // 10. Master Access Passcode Gate
  // --------------------------------------------------------------------------
  const loginGateOverlay = document.getElementById('loginGateOverlay');
  const formMasterKey = document.getElementById('formMasterKey');
  const loginMasterPasscode = document.getElementById('loginMasterPasscode');
  const chkRememberMe = document.getElementById('chkRememberMe');
  const loginErrorBanner = document.getElementById('loginErrorBanner');
  const userSessionBar = document.getElementById('userSessionBar');
  const userEmailDisplay = document.getElementById('userEmailDisplay');
  const btnLogout = document.getElementById('btnLogout');
  const btnToggleLoginPasscode = document.getElementById('btnToggleLoginPasscode');
  const cfgMasterPasscode = document.getElementById('cfgMasterPasscode');
  const btnToggleMasterPasscode = document.getElementById('btnToggleMasterPasscode');

  if (btnToggleLoginPasscode && loginMasterPasscode) {
    btnToggleLoginPasscode.addEventListener('click', () => {
      const isPwd = loginMasterPasscode.type === 'password';
      loginMasterPasscode.type = isPwd ? 'text' : 'password';
      btnToggleLoginPasscode.textContent = isPwd ? 'Hide' : 'Show';
    });
  }

  if (btnToggleMasterPasscode && cfgMasterPasscode) {
    btnToggleMasterPasscode.addEventListener('click', () => {
      const isPwd = cfgMasterPasscode.type === 'password';
      cfgMasterPasscode.type = isPwd ? 'text' : 'password';
      btnToggleMasterPasscode.textContent = isPwd ? 'Hide' : 'Show';
    });
  }

  function checkSession() {
    const local = localStorage.getItem('pf_auth_session');
    const sess = sessionStorage.getItem('pf_auth_session');
    const raw = local || sess;

    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data.user) {
          if (loginGateOverlay) loginGateOverlay.classList.add('hidden');
          if (userSessionBar) userSessionBar.style.display = 'flex';
          if (userEmailDisplay) userEmailDisplay.textContent = data.user;
          return true;
        }
      } catch (e) {
        localStorage.removeItem('pf_auth_session');
        sessionStorage.removeItem('pf_auth_session');
      }
    }

    if (loginGateOverlay) loginGateOverlay.classList.remove('hidden');
    if (userSessionBar) userSessionBar.style.display = 'none';
    return false;
  }

  if (formMasterKey) {
    formMasterKey.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (loginErrorBanner) loginErrorBanner.style.display = 'none';

      const entered = loginMasterPasscode ? loginMasterPasscode.value.trim() : '';
      if (!entered) {
        if (loginErrorBanner) {
          loginErrorBanner.textContent = 'Please enter your master passcode.';
          loginErrorBanner.style.display = 'block';
        }
        return;
      }

      const btnSubmit = document.getElementById('btnMasterKeySubmit');
      const origText = btnSubmit ? btnSubmit.innerHTML : '';
      if (btnSubmit) btnSubmit.innerHTML = '<span>VERIFYING PASSCODE...</span>';

      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/app_secrets?key=eq.master_passcode&select=value`, {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        });

        let validPasscode = 'partyfinder';
        if (res.ok) {
          const data = await res.json();
          if (data && data.length > 0 && data[0].value) {
            validPasscode = data[0].value;
          }
        }

        if (entered === validPasscode) {
          const sessionData = { user: 'Master Admin', timestamp: Date.now() };
          if (chkRememberMe && chkRememberMe.checked) {
            localStorage.setItem('pf_auth_session', JSON.stringify(sessionData));
          } else {
            sessionStorage.setItem('pf_auth_session', JSON.stringify(sessionData));
          }
          if (loginGateOverlay) loginGateOverlay.classList.add('hidden');
          if (userSessionBar) userSessionBar.style.display = 'flex';
          if (userEmailDisplay) userEmailDisplay.textContent = 'Master Admin';
          appendLog('success', 'Studio unlocked: Master Admin authenticated.');
        } else {
          if (loginErrorBanner) {
            loginErrorBanner.textContent = 'Incorrect Master Passcode. Access Denied.';
            loginErrorBanner.style.display = 'block';
          }
        }
      } catch (err) {
        if (loginErrorBanner) {
          loginErrorBanner.textContent = `Verification error: ${err.message}`;
          loginErrorBanner.style.display = 'block';
        }
      } finally {
        if (btnSubmit) btnSubmit.innerHTML = origText;
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      localStorage.removeItem('pf_auth_session');
      sessionStorage.removeItem('pf_auth_session');
      if (loginMasterPasscode) loginMasterPasscode.value = '';
      if (userSessionBar) userSessionBar.style.display = 'none';
      if (loginGateOverlay) loginGateOverlay.classList.remove('hidden');
      appendLog('warn', 'Studio locked. Session terminated.');
    });
  }

  // --------------------------------------------------------------------------
  // Initial Boot
  // --------------------------------------------------------------------------
  checkSession();
  await loadRealms();
  await loadMeta();
  await loadPage(1);
  initSupabaseState().catch(() => {});
  appendLog('info', 'PartyFinder Cloud Studio v2 initialized.');
});
