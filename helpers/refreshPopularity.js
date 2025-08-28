import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { getClient } from '../db/client.js';
dotenv.config();

export async function refreshPopularity(tmdbId, { language = 'fr-CA' } = {}) {
    const url = `https://api.themoviedb.org/3/movie/${tmdbId}?language=${language}&api_key=${process.env.TMDB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB fetch failed for ${tmdbId}: ${res.status}`);
    const data = await res.json();
    const pop = Number(data?.popularity) || 0;

    const client = getClient();
    await client.connect();
    try {
        await client.query('UPDATE movies SET popularity = $1 WHERE id = $2', [pop, tmdbId]);
    } finally {
        await client.end();
    }
    return pop;
}
