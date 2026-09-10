-- PartyFinder Cloud Harvester — Supabase Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- This creates ONLY the harvester state table. Zero player data in Supabase.

-- Harvester operational state (progress, config, logs)
CREATE TABLE IF NOT EXISTS harvester_state (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initial state records
INSERT INTO harvester_state (key, value) 
VALUES
    ('progress', '{
        "us": {"lastScannedPage": 0, "totalPlayers": 0, "enrichedPlayers": 0, "pendingEnrichment": 0, "lastTickAt": null, "lastTickMode": null}
    }'::jsonb),
    ('config', '{
        "primaryRegion": "us",
        "batchSize": 10,
        "autoDeployIntervalMin": 60,
        "wclZoneId": 55
    }'::jsonb),
    ('last_deploy', '{"at": null, "stats": null}'::jsonb),
    ('recent_logs', '[]'::jsonb),
    ('recent_discovered', '[]'::jsonb),
    ('wcl_rate_limit', '{"pointsRemaining": 3600, "limitPerHour": 3600}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Enable Realtime for instant sync to dashboard & desktop monitor
ALTER PUBLICATION supabase_realtime ADD TABLE harvester_state;

-- Done! This table will use < 100 KB of your 500 MB free tier.
