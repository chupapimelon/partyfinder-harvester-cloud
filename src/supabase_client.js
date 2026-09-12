/**
 * Supabase Client — State & secrets reader/writer
 * Stores ONLY harvester operational state (< 1 MB). Zero player data.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://anvkqwbqgqcopsuhhene.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY required');
  _client = createClient(SUPABASE_URL, key);
  return _client;
}

const RETRYABLE_PATTERNS = [
  'gateway timeout',
  '504',
  '502',
  '503',
  'etimedout',
  'econnreset',
  'fetch failed',
  'network timeout',
  'request timed out',
];

function isTransientError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  return RETRYABLE_PATTERNS.some(p => msg.includes(p));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read a harvester state value by key with automatic retry on transient gateway/network errors
 * @param {string} key — e.g., 'progress', 'config', 'recent_logs'
 * @param {number} [maxRetries=3]
 * @returns {object|null} The JSONB value
 */
async function getState(key, maxRetries = 3) {
  let delayMs = 1500;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sb = getClient();
      const { data, error } = await sb
        .from('harvester_state')
        .select('value')
        .eq('key', key)
        .single();
      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        if (attempt < maxRetries && isTransientError(error)) {
          console.warn(`[Supabase] getState("${key}") transient error (${error.message}). Retrying ${attempt}/${maxRetries} in ${delayMs}ms...`);
          await sleep(delayMs);
          delayMs *= 2;
          continue;
        }
        console.warn(`[Supabase] getState("${key}") error:`, error.message);
        return null;
      }
      return data?.value ?? null;
    } catch (err) {
      if (attempt < maxRetries && isTransientError(err)) {
        console.warn(`[Supabase] getState("${key}") network error (${err.message}). Retrying ${attempt}/${maxRetries} in ${delayMs}ms...`);
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }
      console.warn(`[Supabase] getState("${key}") network exception:`, err.message);
      return null;
    }
  }
  return null;
}

/**
 * Write a harvester state value (upsert) with automatic retry on transient gateway/network errors
 * @param {string} key
 * @param {object} value — JSONB value
 * @param {number} [maxRetries=3]
 */
async function setState(key, value, maxRetries = 3) {
  let delayMs = 1500;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sb = getClient();
      const { error } = await sb
        .from('harvester_state')
        .upsert(
          { key, value, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
      if (error) {
        if (attempt < maxRetries && isTransientError(error)) {
          console.warn(`[Supabase] setState("${key}") transient error (${error.message}). Retrying ${attempt}/${maxRetries} in ${delayMs}ms...`);
          await sleep(delayMs);
          delayMs *= 2;
          continue;
        }
        console.error(`[Supabase] setState("${key}") error:`, error.message);
        throw error;
      }
      return;
    } catch (err) {
      if (attempt < maxRetries && isTransientError(err)) {
        console.warn(`[Supabase] setState("${key}") network exception (${err.message}). Retrying ${attempt}/${maxRetries} in ${delayMs}ms...`);
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Append log entries to the recent_logs state
 * Keeps only the last 50 log entries. Safe against transient failure.
 * @param {Array<{type: string, message: string, time: string}>} newLogs
 */
async function appendLogs(newLogs) {
  try {
    const existing = (await getState('recent_logs')) || [];
    const combined = [...existing, ...newLogs].slice(-50);
    await setState('recent_logs', combined);
  } catch (err) {
    console.warn('[Supabase] appendLogs non-fatal warning:', err.message || err);
  }
}

/**
 * Read WCL credentials from the existing app_secrets table
 * @returns {{ clientId: string, clientSecret: string } | null}
 */
async function getWclCredentials() {
  const sb = getClient();
  const { data, error } = await sb
    .from('app_secrets')
    .select('key,value');
  if (error || !data) {
    console.warn('[Supabase] Failed to read app_secrets:', error?.message);
    return null;
  }
  const clientId = data.find(s => s.key === 'wcl_client_id')?.value;
  const clientSecret = data.find(s => s.key === 'wcl_client_secret')?.value;
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

module.exports = {
  getClient,
  getState,
  setState,
  appendLogs,
  getWclCredentials,
};
