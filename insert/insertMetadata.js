// insert/insertMetadata.js
import fetch from 'node-fetch';
import { getClient } from '../db/client.js';
import dotenv from 'dotenv';
import { fetchReleaseDateFromCinoche } from '../helpers/cinocheReleaseDate.js';
dotenv.config();

/**
 * Insert full metadata if new; if the movie already exists, refresh ONLY popularity.
 * @param {number} tmdbId - The TMDB ID of the movie
 * @param {string|null} fr_title - The French title of the movie
 * @param {string|null} baseFilmUrl - Optional Cinoche URL to fetch release date from
 */
export async function insertMetadata(tmdbId, fr_title = null, baseFilmUrl = null) {
    console.log(`→ insertMetadata: tmdbId=${tmdbId}, fr_title="${fr_title}", baseFilmUrl="${baseFilmUrl}"`);
    const client = getClient();
    await client.connect();

    try {
        await client.query('BEGIN');

        // --- 0) Does the movie already exist? If yes: refresh popularity only ---
        const existing = await client.query(
            `SELECT id, popularity FROM movies WHERE id = $1`,
            [tmdbId]
        );

        if (existing.rowCount > 0) {
            // Fetch only the light details endpoint (has "popularity")
            const detailsResp = await fetch(
                `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`
            );
            const details = await detailsResp.json();
            const newPopularity = details.popularity ?? 0;

            // Try to get Cinoche release date if baseFilmUrl is provided
            let cinocheReleaseDate = null;
            if (baseFilmUrl) {
                try {
                    cinocheReleaseDate = await fetchReleaseDateFromCinoche(baseFilmUrl);
                    if (cinocheReleaseDate) {
                        console.log(`Found Cinoche release date for existing movie: ${cinocheReleaseDate}`);
                    }
                } catch (err) {
                    console.warn(`Failed to fetch Cinoche release date: ${err.message}`);
                }
            }

            // Update popularity and optionally release_date
            if (cinocheReleaseDate) {
                await client.query(
                    `UPDATE movies SET popularity = $2, release_date = $3 WHERE id = $1`,
                    [tmdbId, newPopularity, cinocheReleaseDate]
                );
                console.log(`↷ Updated movie ${tmdbId}: popularity → ${newPopularity}, release_date → ${cinocheReleaseDate}`);
            } else {
                await client.query(
                    `UPDATE movies SET popularity = $2 WHERE id = $1`,
                    [tmdbId, newPopularity]
                );
                console.log(`↷ Popularity refreshed for movie ${tmdbId} → ${newPopularity}`);
            }

            // Fill in fr_title if missing
            if (fr_title) {
                await client.query(
                    `UPDATE movies SET fr_title = COALESCE(fr_title, $2) WHERE id = $1`,
                    [tmdbId, fr_title]
                );
            }

            await client.query('COMMIT');
            return;
        }

        // --- 1) New movie path: full insert + links ---
        const [detailsResp, creditsResp] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`),
            fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${process.env.TMDB_API_KEY}`)
        ]);
        const details = await detailsResp.json();
        const credits = await creditsResp.json();

        const imagesResp = await fetch(
            `https://api.themoviedb.org/3/movie/${tmdbId}/images?api_key=${process.env.TMDB_API_KEY}&include_image_language=fr,en,null`
        );
        const images = await imagesResp.json();

        function choosePoster(details, images) {
            const posters = (images.posters || []).slice();
            const prefRank = p => (p.iso_639_1 === 'fr' ? 3 : p.iso_639_1 === 'en' ? 2 : 1);
            posters.sort((a,b) => (prefRank(b) - prefRank(a)) || ((b.vote_count||0) - (a.vote_count||0)));
            return posters[0]?.file_path || details.poster_path || null;
        }

        // Prefer Cinoche release date over TMDB if available
        let releaseDate = null;
        if (baseFilmUrl) {
            try {
                const cinocheReleaseDate = await fetchReleaseDateFromCinoche(baseFilmUrl);
                if (cinocheReleaseDate) {
                    releaseDate = cinocheReleaseDate;
                    console.log(`Using Cinoche release date: ${releaseDate}`);
                }
            } catch (err) {
                console.warn(`Failed to fetch Cinoche release date: ${err.message}`);
            }
        }
        // Fallback to TMDB release date if Cinoche date not found
        if (!releaseDate) {
            releaseDate = details.release_date || null;
            if (releaseDate) {
                console.log(`Using TMDB release date: ${releaseDate}`);
            }
        }

        const popularity = details.popularity ?? 0;
        const poster     = choosePoster(details, images);
        const backdrop   = details.backdrop_path ?? null;
        const budget     = (details.budget  && details.budget  > 0) ? details.budget  : null;
        const runtime    = (details.runtime && details.runtime > 0) ? details.runtime : null;

        // 1) Insert (first time) – keep your "fill only missing" semantics on conflict,
        //    but we expect no conflict here because we checked existence above.
        await client.query(
            `
                INSERT INTO movies (id, title, fr_title, release_date, popularity, poster_path, backdrop_path, budget, runtime)
                VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO UPDATE
                    SET
                        title         = COALESCE(movies.title, EXCLUDED.title),
                        fr_title      = COALESCE(movies.fr_title, EXCLUDED.fr_title),
                        release_date  = COALESCE(movies.release_date, EXCLUDED.release_date),
                        poster_path   = COALESCE(movies.poster_path, EXCLUDED.poster_path),
                        backdrop_path = COALESCE(movies.backdrop_path, EXCLUDED.backdrop_path),
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
                        -- For initial insert we keep your old "max" behavior; after that we only refresh popularity in the fast path above
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
        console.log(`✓ Métadonnées complètes insérées pour "${details.title}" (ID: ${tmdbId})`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Erreur dans insertMetadata:', e);
    } finally {
        await client.end();
    }
}
