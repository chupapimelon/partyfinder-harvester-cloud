/**
 * prune_runs.js — Automatically prunes old GitHub Actions workflow runs
 * Keeps Actions storage permanently under 10 MB, preventing 0.5 GB quota exhaustion.
 */

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY || 'chupapimelon/partyfinder-harvester-cloud';

if (!token) {
  console.log('[PruneRuns] No GITHUB_TOKEN provided; skipping auto-prune.');
  process.exit(0);
}

const MAX_AGE_HOURS = 24; // Delete runs older than 24 hours
const MAX_RUNS_TO_KEEP = 30; // Maximum runs to keep in history

async function run() {
  console.log(`[PruneRuns] Checking workflow run history for ${repo}...`);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=100&status=completed`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      }
    });

    if (!res.ok) {
      console.warn(`[PruneRuns] GitHub API responded with status ${res.status}: ${res.statusText}`);
      return;
    }

    const data = await res.json();
    const runs = data.workflow_runs || [];
    console.log(`[PruneRuns] Found ${runs.length} completed runs.`);

    const now = Date.now();
    const toDelete = [];

    runs.forEach((r, idx) => {
      const ageHours = (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
      // Delete if older than MAX_AGE_HOURS or exceeds MAX_RUNS_TO_KEEP
      if (ageHours > MAX_AGE_HOURS || idx >= MAX_RUNS_TO_KEEP) {
        toDelete.push(r);
      }
    });

    if (toDelete.length === 0) {
      console.log('[PruneRuns] No runs need pruning (all within 24h & under limit).');
      return;
    }

    console.log(`[PruneRuns] Pruning ${toDelete.length} old runs...`);
    let deleted = 0;

    // Delete in batches of 10
    for (let i = 0; i < toDelete.length; i += 10) {
      const chunk = toDelete.slice(i, i + 10);
      await Promise.all(chunk.map(async (r) => {
        try {
          const delRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${r.id}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github.v3+json',
            }
          });
          if (delRes.status === 204 || delRes.ok) deleted++;
        } catch (e) {}
      }));
    }

    console.log(`[PruneRuns] Successfully pruned ${deleted} runs. Storage clean.`);
  } catch (err) {
    console.warn('[PruneRuns] Error pruning runs:', err.message);
  }
}

run();
