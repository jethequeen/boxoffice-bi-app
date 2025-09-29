import fetch from "node-fetch";
import dotenv from "dotenv";
import { getClient } from "../db/client.js";
dotenv.config();

const PROV_BASE = 1_000_000_000; // your temp-id band start

export async function refreshPopularityAndBudget(tmdbId, { language = "fr-CA" } = {}) {
    // Skip provisional IDs (they’re not TMDb IDs)
    if (Number(tmdbId) >= PROV_BASE) {
        return { popularity: null, budget: null, skipped: true };
    }

    const url = `https://api.themoviedb.org/3/movie/${tmdbId}?language=${language}&api_key=${process.env.TMDB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB fetch failed for ${tmdbId}: ${res.status}`);
    const data = await res.json();

    const pop = Number(data?.popularity) || 0;
    // TMDb returns budget in USD (integer). 0 means “unknown”.
    const budget = Number.isFinite(Number(data?.budget)) ? Number(data.budget) : null;

    const client = getClient();
    await client.connect();
    try {
        await client.query(
            `UPDATE movies
         SET popularity = $1,
             budget     = $2
       WHERE id = $3`,
            [pop, budget === 0 ? null : budget, tmdbId]
        );
    } finally {
        await client.end();
    }

    return { popularity: pop, budget: budget === 0 ? null : budget, skipped: false };
}

// Backward-compatible alias if other code still calls the old name
export const refreshPopularity = refreshPopularityAndBudget;
