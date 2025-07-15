// 📁 boxoffice-cron/insert/insertMetadata.js
import fetch from 'node-fetch';
import { getClient } from '../db/client.js';
import dotenv from 'dotenv';
dotenv.config();

export async function insertMetadata(tmdbId, fr_title) {
    console.log(`→ insertMetadata: tmdbId=${tmdbId}, fr_title="${fr_title}"`);
    const client = getClient();
    await client.connect();

    try {
        const [detailsResp, creditsResp] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`),
            fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${process.env.TMDB_API_KEY}`)
        ]);

        const details = await detailsResp.json();
        const credits = await creditsResp.json();

        // 1. Insert movie
        await client.query(
            `INSERT INTO movies (id, title, fr_title, release_date, popularity)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE
                 SET fr_title = EXCLUDED.fr_title
             WHERE movies.fr_title IS NULL`,
            [tmdbId, details.title, fr_title, details.release_date, details.popularity]
        );


        // 2. Insert genres
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

        // 3. Insert countries
        for (const country of details.production_countries || []) {
            await client.query(
                `INSERT INTO countries (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
                [country.iso_3166_1, country.name]
            );
            await client.query(
                `INSERT INTO movie_countries (movie_id, country_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [tmdbId, country.iso_3166_1]
            );
        }

        // 4. Insert studios
        for (const studio of details.production_companies || []) {
            await client.query(
                `INSERT INTO studios (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
                [studio.id, studio.name]
            );
            await client.query(
                `INSERT INTO movie_studio (movie_id, studio_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [tmdbId, studio.id]
            );
        }

        // 5. Insert directors
        const directors = (credits.crew || []).filter(p => p.job === "Director");
        for (const director of directors) {
            await client.query(
                `INSERT INTO crew (id, name, known_for_department, popularity, gender, image_path)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO NOTHING`,
                [director.id, director.name, director.known_for_department, director.popularity, director.gender, director.profile_path]
            );
            await client.query(
                `INSERT INTO movie_crew (movie_id, crew_id, job)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [tmdbId, director.id, director.job]
            );
        }

        // 6. Insert top 9 actors
        const cast = credits.cast?.slice(0, 9) || [];
        for (const actor of cast) {
            await client.query(
                `INSERT INTO actors (id, name, popularity, gender, profile_path, known_for_department)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO NOTHING`,
                [actor.id, actor.name, actor.popularity, actor.gender, actor.profile_path, actor.known_for_department]
            );
            await client.query(
                `INSERT INTO movie_actors (movie_id, actor_id, "order")
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [tmdbId, actor.id, actor.order]
            );
        }

        console.log(`✓ Métadonnées insérées pour ${details.title}`);
    } catch (e) {
        console.error('❌ Erreur dans insertMetadata:', e);
    } finally {
        await client.end();
    }
}
