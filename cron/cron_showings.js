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
import {ensureMovieIdOrPlaceholder} from "../helpers/movieIDorPlaceHolder.js";

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
                const film_id = await ensureMovieIdOrPlaceholder(db, {
                    title: c.title,
                    yearHint,
                    baseFilmUrl,
                    extraQueries: [slugTitle, ...langTitles].filter(Boolean)
                });

                const added = await insertShowingsForMovie(film_id, c.blocks);
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
    process.exit(0);
} catch (e) {
    console.error("Fatal:", e?.message || e);
    process.exit(1);
}
