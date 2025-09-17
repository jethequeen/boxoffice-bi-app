// helpers/ensureMovieIdOrPlaceholder.js
import { searchMovie } from "../insert/searchMovie.js";
import { insertMetadata } from "../insert/insertMetadata.js";

const PROV_BASE  = 1_000_000_000;        // reserved band start (inclusive)
const PROV_LIMIT = 2_000_000_000 - 1;    // well inside INT32 max

async function genProvisionalId(db) {
    for (let i = 0; i < 8; i++) {
        const id = PROV_BASE + Math.floor(Math.random() * (PROV_LIMIT - PROV_BASE + 1));
        const { rows } = await db.query("SELECT 1 FROM movies WHERE id=$1", [id]);
        if (rows.length === 0) return id;
    }
    throw new Error("Could not generate a unique provisional id");
}

export async function ensureMovieIdOrPlaceholder(db, { title, yearHint, baseFilmUrl, extraQueries=[] }) {
    // 1) local by year
    if (yearHint) {
        const { rows } = await db.query(
            `SELECT id FROM movies
             WHERE (fr_title=$1 OR title=$1)
               AND release_date BETWEEN ($2||'-01-01')::date AND ($3||'-12-31')::date
             ORDER BY popularity DESC NULLS LAST LIMIT 1`,
            [title, yearHint-1, yearHint+1]
        );
        if (rows[0]) return rows[0].id;
    }

    // 2) TMDB search
    const qs = [...new Set([title, ...extraQueries])];
    for (const q of qs) {
        const m =
            (await searchMovie(q, yearHint,  { strict:true, tol:1, allowNoYearFallback:false })) ||
            (await searchMovie(q, yearHint-1,{ strict:true, tol:0 })) ||
            (await searchMovie(q, yearHint+1,{ strict:true, tol:0 }));
        if (m?.id) {
            await insertMetadata(m.id, title);
            return m.id;
        }
    }

    // 3) reuse existing placeholder for same title/url
    const reuse = await db.query(
        `SELECT id FROM movies
         WHERE provisional = TRUE
           AND (lower(fr_title)=lower($1) OR lower(title)=lower($1) OR source_url=$2)
         ORDER BY id DESC LIMIT 1`,
        [title, baseFilmUrl || null]
    );
    if (reuse.rows[0]) return reuse.rows[0].id;

    // 4) create new placeholder in the reserved band
    const tempId = await genProvisionalId(db);
    // If id is GENERATED ALWAYS, use: INSERT ... OVERRIDING SYSTEM VALUE
    await db.query(
        `INSERT INTO movies (id, fr_title, title, provisional, source_url)
         VALUES ($1, $2, $2, TRUE, $3)
         ON CONFLICT (id) DO NOTHING`,
        [tempId, title, baseFilmUrl || null]
    );
    return tempId;
}
