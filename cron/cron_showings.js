import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { getProgram } from "../scraper/programmation.js";
import { fetchLanguageDerivedTitles } from "../helpers/originalFilmTitle.js";
import { insertMetadata } from "../insert/insertMetadata.js";
import { insertShowingsForMovie } from "../insert/insertShowings.js";
import { searchMovie } from "../insert/searchMovie.js";
import { getClient } from "../db/client.js";

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
const MIN_SHOWS = Number(process.env.MIN_SHOWINGS || 5);
const MAX_FILMS = Number(process.env.MAX_FILMS || 500);
const SLEEP_MS  = Number(process.env.SHOWINGS_SLEEP_MS || 250);



// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toBaseFilmUrl(hrefOrUrl) {
    const base = "https://www.cinoche.com";
    const u = hrefOrUrl.startsWith("http") ? new URL(hrefOrUrl) : new URL(hrefOrUrl, base);
    u.pathname = u.pathname.replace(/\/(horaires|critiques|bandes-annonces)(\/)?$/i, "");
    return u.toString();
}
function slugToTitle(href) {
    const slug = href.split("?")[0].replace(/\/$/, "").split("/").pop() || "";
    return slug.replace(/-vf(of)?/i, "").replace(/-/g, " ").replace(/\b\w/g, m => m.toUpperCase()).trim();
}
function uniqueNonEmpty(arr){const s=new Set();for(const x of arr){const v=(x||"").trim();if(v)s.add(v)}return [...s]}

function yearFromBlocks(blocks){
    const ys=(blocks||[]).map(b=>(b?.dateISO||"").slice(0,4)).filter(y=>/^\d{4}$/.test(y)).map(Number);
    return ys.length ? Math.min(...ys) : undefined;
}

// ---------- job body (top-level) ----------
try {
    const films = await getProgram({ minShows: MIN_SHOWS, maxFilms: MAX_FILMS, sleepMs: SLEEP_MS });
    if (!films.length) {
        console.log("No candidates with sufficient showings found.");
        process.exit(0);
    }
    const db = getClient();
    await db.connect();
    try {

        let processed = 0;
        for (const c of films) {
            try {
                const baseFilmUrl = toBaseFilmUrl(c.href);
                const langTitles  = await fetchLanguageDerivedTitles(baseFilmUrl); // <-- NEW
                const slugTitle   = slugToTitle(c.href);

                const BAD = /(th[eé]âtre|cin[eé]|rgfm|guzzo|beaubien|forum|imax|vip)/i;
                const queries = uniqueNonEmpty([
                    ...langTitles,
                    c.title,
                    slugTitle
                ]).filter(t => !BAD.test(t));



                const yearHint = yearFromBlocks(c.blocks);
                let match = null;

                if (yearHint) {
                    const { rows } = await db.query(
                        `SELECT id
                           FROM movies
                          WHERE (fr_title = $1 OR title = $1)
                            AND release_date BETWEEN ($2||'-01-01')::date AND ($3||'-12-31')::date
                          ORDER BY popularity DESC NULLS LAST
                          LIMIT 1`,
                        [c.title, yearHint - 1, yearHint + 1]
                    );
                    if (rows[0]) {
                        match = { id: rows[0].id };
                    }
                }

                if (!match) {
                    for (const q of queries) {
                        match = await searchMovie(q, yearHint, { strict: true, tol: 1, allowNoYearFallback: false })
                            || await searchMovie(q, yearHint-1, { strict: true, tol: 0 })
                            || await searchMovie(q, yearHint+1, { strict: true, tol: 0 });
                        if (match?.id) break;
                    }
                }
                if (!match?.id) {
                    console.log(`⚠️ No TMDB match (year-strict) for ${c.title} (${yearHint})`);
                    continue;
                }

                const tmdbId = match.id;
                await insertMetadata(tmdbId, c.title);
                const added = await insertShowingsForMovie(tmdbId, c.blocks);

                const tag = added > 0 ? "ADD" : "OK";
                console.log(`[${tag}] ${c.title} — total week showings: ${c.total} (inserted ${added})`);

                processed++;
                if (SLEEP_MS > 0) await sleep(SLEEP_MS);
            } catch (filmErr) {
                console.warn(`⚠️ Film error (${c?.title || "?"}):`, filmErr?.message || filmErr);
            }
        }

    } finally {
        await db.end();
    }

    console.log(`Done. Processed ${processed}/${films.length} candidate(s).`);
    process.exit(0);
} catch (e) {
    console.error("Fatal:", e?.message || e);
    process.exit(1);
}
