import fetch from 'node-fetch';
import { getClient } from '../db/client.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Update technical fields for an existing movie in the DB.
 * Fields: poster_path, backdrop_path, budget, runtime
 */
export async function updateTechnicalMetadata(tmdbId) {
    console.log(`→ updateTechnicalMetadata: tmdbId=${tmdbId}`);
    const client = getClient();
    await client.connect();

    try {
        const response = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`);
        const details = await response.json();

        if (details.status_code) {
            throw new Error(`TMDB error: ${details.status_message}`);
        }

        const query = `
            UPDATE movies
            SET
                poster_path = $1,
                backdrop_path = $2,
                budget = $3,
                runtime = $4
            WHERE id = $5
        `;

        const values = [
            details.poster_path,
            details.backdrop_path,
            details.budget,
            details.runtime,
            tmdbId
        ];

        await client.query(query, values);

        console.log(`✓ Données techniques mises à jour pour "${details.title}" (ID: ${tmdbId})`);
    } catch (e) {
        console.error(`❌ Erreur pour le film ID ${tmdbId}:`, e.message);
    } finally {
        await client.end();
    }
}

if (process.argv[1].endsWith('updateTechnicalMetadata.js') && process.argv.length > 2) {
    const ids = process.argv.slice(2).map(id => parseInt(id, 10)).filter(id => !isNaN(id));

    if (ids.length === 0) {
        console.error('❌ Aucun ID valide fourni.');
        process.exit(1);
    }

    (async () => {
        for (const id of ids) {
            await updateTechnicalMetadata(id);
        }
    })();
}
