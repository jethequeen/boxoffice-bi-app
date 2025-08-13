// 📁 boxoffice-cron/insert/insertMetadata.js
import fetch from 'node-fetch';
import { getClient } from '../db/client.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Upsert full movie metadata (details + credits) into DB.
 * - Inserts if new
 * - If already present, fills only missing fields:
 *     fr_title, poster_path, backdrop_path, release_date, budget, runtime
 *   (budget/runtime also updated when current value = 0)
 * - Also (idempotently) links genres, countries, studios, directors, top 9 actors.
 */
export async function insertMetadata(tmdbId, fr_title = null) {
    console.log(`→ insertMetadata: tmdbId=${tmdbId}, fr_title="${fr_title}"`);
    const client = getClient();
    await client.connect();

    try {
        await client.query('BEGIN');

        const [detailsResp, creditsResp] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`),
            fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${process.env.TMDB_API_KEY}`)
        ]);

        const details = await detailsResp.json();
        const credits = await creditsResp.json();

        if (details.status_code) {
            throw new Error(`TMDB error: ${details.status_message}`);
        }

        const releaseDate = details.release_date || null; // can be null/empty
        const popularity = details.popularity ?? 0;
        const poster = details.poster_path ?? null;
        const backdrop = details.backdrop_path ?? null;
        const budget = (details.budget && details.budget > 0) ? details.budget : null;
        const runtime = (details.runtime && details.runtime > 0) ? details.runtime : null;

        // 1) Upsert movie (fill only missing)
        await client.query(
            `
      INSERT INTO movies (id, title, fr_title, release_date, popularity, poster_path, backdrop_path, budget, runtime)
      VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE
      SET
        -- keep current non-null values; otherwise take the incoming one
        title         = COALESCE(movies.title, EXCLUDED.title),
        fr_title      = COALESCE(movies.fr_title, EXCLUDED.fr_title),
        release_date  = COALESCE(movies.release_date, EXCLUDED.release_date),
        poster_path   = COALESCE(movies.poster_path, EXCLUDED.poster_path),
        backdrop_path = COALESCE(movies.backdrop_path, EXCLUDED.backdrop_path),
        -- when current is NULL or 0, adopt the incoming value (if any)
        budget        = CASE
                           WHEN movies.budget IS NULL OR movies.budget = 0
                           THEN COALESCE(EXCLUDED.budget, movies.budget)
                           ELSE movies.budget
                        END,
        runtime       = CASE
                           WHEN movies.runtime IS NULL OR movies.runtime = 0
                           THEN COALESCE(EXCLUDED.runtime, movies.runtime)
                           ELSE movies.runtime
                        END,
        -- keep the higher popularity as a harmless tiebreaker
        popularity    = GREATEST(COALESCE(movies.popularity, 0), COALESCE(EXCLUDED.popularity, 0))
      `,
            [
                tmdbId,
                details.title ?? null,
                fr_title,
                releaseDate,
                popularity,
                poster,
                backdrop,
                budget,
                runtime
            ]
        );

        // 2) Genres
        for (const genre of details.genres || []) {
            await client.query(
                `INSERT INTO genres (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
                [genre.id, genre.name]
            );
            await client.query(
                `INSERT INTO movie_genres (movie_id, genre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [tmdbId, genre.id]
            );
        }

        // 3) Countries
        for (const c of details.production_countries || []) {
            await client.query(
                `INSERT INTO countries (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
                [c.iso_3166_1, c.name]
            );
            await client.query(
                `INSERT INTO movie_countries (movie_id, country_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [tmdbId, c.iso_3166_1]
            );
        }

        // 4) Studios
        for (const s of details.production_companies || []) {
            await client.query(
                `INSERT INTO studios (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
                [s.id, s.name]
            );
            await client.query(
                `INSERT INTO movie_studio (movie_id, studio_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [tmdbId, s.id]
            );
        }

        // 5) Directors
        const directors = (credits.crew || []).filter(p => p.job === 'Director');
        for (const d of directors) {
            await client.query(
                `INSERT INTO crew (id, name, known_for_department, popularity, gender, image_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
                [d.id, d.name, d.known_for_department, d.popularity, d.gender, d.profile_path]
            );
            await client.query(
                `INSERT INTO movie_crew (movie_id, crew_id, job)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
                [tmdbId, d.id, d.job]
            );
        }

        // 6) Top 9 actors
        const cast = credits.cast?.slice(0, 9) || [];
        for (const a of cast) {
            await client.query(
                `INSERT INTO actors (id, name, popularity, gender, profile_path, known_for_department)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
                [a.id, a.name, a.popularity, a.gender, a.profile_path, a.known_for_department]
            );
            await client.query(
                `INSERT INTO movie_actors (movie_id, actor_id, "order")
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
                [tmdbId, a.id, a.order]
            );
        }

        await client.query('COMMIT');
        console.log(`✓ Métadonnées complètes insérées/mises à jour pour "${details.title}" (ID: ${tmdbId})`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Erreur dans insertMetadata:', e);
    } finally {
        await client.end();
    }
}

// Optional CLI usage like before
if (process.argv[1]?.endsWith('insertMetadata.js') && process.argv.length > 2) {
    const ids = process.argv.slice(2).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
    if (ids.length === 0) {
        console.error('❌ Aucun ID valide fourni.');
        process.exit(1);
    }
    (async () => {
        for (const id of ids) {
            await insertMetadata(id);
        }
    })();
}
