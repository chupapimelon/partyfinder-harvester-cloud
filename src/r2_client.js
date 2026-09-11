/**
 * Cloudflare R2 Client — S3-compatible storage helper
 * Handles all player data read/write operations to R2
 */
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getCurrentSeason } = require('./season_detector');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'partyfinder-data';

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 credentials not set. Required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

/**
 * Download a JSON file from R2
 * @param {string} key — R2 object key (e.g., 'data/rio_players_us.json')
 * @returns {object|null} Parsed JSON or null if not found
 */
async function getJSON(key) {
  try {
    const client = getClient();
    const res = await client.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    }));
    const bodyStr = await res.Body.transformToString('utf-8');
    return JSON.parse(bodyStr);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Upload a JSON file to R2
 * @param {string} key — R2 object key
 * @param {object} data — Object to serialize as JSON
 * @param {boolean} pretty — Whether to pretty-print (default false for size)
 */
async function putJSON(key, data, pretty = false) {
  const client = getClient();
  const body = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  }));
}

/**
 * Upload raw string content to R2
 * @param {string} key — R2 object key
 * @param {string} content — Raw string content
 * @param {string} contentType — MIME type
 */
async function putRaw(key, content, contentType = 'application/octet-stream') {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: content,
    ContentType: contentType,
  }));
}

/**
 * List objects in R2 with a prefix
 * @param {string} prefix — Key prefix to filter
 * @returns {Array<{Key: string, Size: number, LastModified: Date}>}
 */
async function listObjects(prefix) {
  const client = getClient();
  const res = await client.send(new ListObjectsV2Command({
    Bucket: R2_BUCKET_NAME,
    Prefix: prefix,
  }));
  return res.Contents || [];
}

/**
 * Delete an object from R2
 * @param {string} key — R2 object key
 */
async function deleteObject(key) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
}

/**
 * Download the full player registry for a region
 * @param {string} region — 'us', 'eu', 'kr', 'tw'
 * @returns {object} Registry object with { players, lastScannedPage, ... }
 */
async function loadPlayerRegistry(region) {
  const reg = (region || 'us').toLowerCase();
  const data = await getJSON(`data/rio_players_${reg}.json`);
  if (data && data.players) {
    if (typeof data.lastScannedPage !== 'number') {
      data.lastScannedPage = Math.floor(Object.keys(data.players).length / 100);
    }
    return data;
  }
  return {
    region: reg.toUpperCase(),
    season: getCurrentSeason(),
    updatedAt: 0,
    totalUnique: 0,
    lastScannedPage: 0,
    players: {},
  };
}

/**
 * Save the full player registry back to R2
 * @param {string} region
 * @param {object} registry
 */
async function savePlayerRegistry(region, registry) {
  const reg = (region || 'us').toLowerCase();
  registry.updatedAt = Date.now();
  registry.season = registry.season || getCurrentSeason();
  registry.totalUnique = Object.keys(registry.players).length;
  if (typeof registry.lastScannedPage !== 'number') {
    registry.lastScannedPage = 0;
  }
  // Use non-pretty JSON to reduce file size (saves ~40% on 62MB file)
  await putJSON(`data/rio_players_${reg}.json`, registry, false);
}

module.exports = {
  getJSON,
  putJSON,
  putRaw,
  listObjects,
  deleteObject,
  loadPlayerRegistry,
  savePlayerRegistry,
};
