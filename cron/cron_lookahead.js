import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { getClient } from "../db/client.js";
import { getFutureMonthsMovies } from "../scraper/comingSoon.js";
import { fetchLanguageDerivedTitles } from "../helpers/originalFilmTitle.js";
import { ensureMovieIdOrPlaceholder } from "../helpers/movieIDorPlaceHolder.js";
import { insertMetadata } from "../insert/insertMetadata.js";

// ---------- .env loading ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envCandidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../.env"),
];
for (const p of envCandidates) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        break;
    }
}

// ---------- config ----------
const SLEEP_MS = Number(process.env.LOOKAHEAD_SLEEP_MS || 250);

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugToTitle(href) {
    const slug = href.split("?")[0].replace(/\/$/, "").split("/").pop() || "";
    return slug.replace(/-vf(of)?/i, "").replace(/-/g, " ").replace(/\b\w/g, m => m.toUpperCase()).trim();
}

function uniqueNonEmpty(arr) {
    const s = new Set();
    for (const x of arr) {
        const v = (x || "").trim();
        if (v) s.add(v);
    }
    return [...s];
}

// ---------- Main Script ----------
(async () => {
    console.log("=== Starting weekly look-ahead cron (future months) ===\n");

    try {
        // Fetch all movies from future months (beyond next month)
        const futureMovies = await getFutureMonthsMovies();

        if (!futureMovies.length) {
            console.log("No future movies found.");
            process.exit(0);
        }

        console.log(`Found ${futureMovies.length} movies from future months\n`);

        const db = getClient();
        await db.connect();

        try {
            let processed = 0;
            let updated = 0;
            let inserted = 0;

            for (const movie of futureMovies) {
                try {
                    const baseFilmUrl = movie.href;
                    const langTitles = await fetchLanguageDerivedTitles(baseFilmUrl);
                    const slugTitle = slugToTitle(movie.href);

                    const BAD = /(th[eé]âtre|cin[eé]|rgfm|guzzo|beaubien|forum|imax|vip)/i;
                    const queries = uniqueNonEmpty([
                        ...langTitles,
                        movie.title,
                        slugTitle
                    ]).filter(t => !BAD.test(t));

                    // Try to extract year from release date if available
                    let yearHint;
                    if (movie.releaseDate) {
                        const year = parseInt(movie.releaseDate.split('-')[0], 10);
                        if (!isNaN(year)) {
                            yearHint = year;
                        }
                    }

                    // Check if movie already exists
                    const existingCheck = await db.query(
                        `SELECT id FROM movies WHERE id = (
                            SELECT id FROM movies
                            WHERE fr_title = $1 OR title = $1
                            ORDER BY id LIMIT 1
                        )`,
                        [movie.title]
                    );

                    const movieExists = existingCheck.rowCount > 0;

                    // Ensure movie exists in database
                    const film_id = await ensureMovieIdOrPlaceholder(db, {
                        title: movie.title,
                        yearHint,
                        baseFilmUrl,
                        extraQueries: [slugTitle, ...langTitles].filter(Boolean)
                    });

                    if (movieExists) {
                        updated++;
                        console.log(`[UPDATE] ${movie.title} (ID: ${film_id}) — Release: ${movie.releaseDate || 'TBD'}`);
                    } else {
                        inserted++;
                        console.log(`[INSERT] ${movie.title} (ID: ${film_id}) — Release: ${movie.releaseDate || 'TBD'}`);
                    }

                    processed++;
                    if (SLEEP_MS > 0) await sleep(SLEEP_MS);

                } catch (movieErr) {
                    console.error(`✗ Error processing movie (${movie?.title || "?"}):`, movieErr.message);
                    // Continue with next movie
                }
            }

            console.log(`\n=== Look-ahead cron complete ===`);
            console.log(`Total processed: ${processed}`);
            console.log(`Inserted: ${inserted}`);
            console.log(`Updated: ${updated}`);

        } finally {
            await db.end();
        }

        process.exit(0);

    } catch (error) {
        console.error("Fatal error:", error);
        process.exit(1);
    }
})();
