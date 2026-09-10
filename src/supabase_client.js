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

/**
 * Read a harvester state value by key
 * @param {string} key — e.g., 'progress', 'config', 'recent_logs'
 * @returns {object|null} The JSONB value
 */
async function getState(key) {
  const sb = getClient();
  const { data, error } = await sb
    .from('harvester_state')
    .select('value')
    .eq('key', key)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    console.warn(`[Supabase] getState("${key}") error:`, error.message);
    return null;
  }
  return data?.value ?? null;
}

/**
 * Write a harvester state value (upsert)
 * @param {string} key
 * @param {object} value — JSONB value
 */
async function setState(key, value) {
  const sb = getClient();
  const { error } = await sb
    .from('harvester_state')
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  if (error) {
    console.error(`[Supabase] setState("${key}") error:`, error.message);
    throw error;
  }
}

/**
 * Append log entries to the recent_logs state
 * Keeps only the last 50 log entries
 * @param {Array<{type: string, message: string, time: string}>} newLogs
 */
async function appendLogs(newLogs) {
  const existing = (await getState('recent_logs')) || [];
  const combined = [...existing, ...newLogs].slice(-50);
  await setState('recent_logs', combined);
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
