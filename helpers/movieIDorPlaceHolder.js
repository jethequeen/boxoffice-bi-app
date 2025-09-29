// helpers/ensureMovieIdOrPlaceholder.js
import { searchMovie } from "../insert/searchMovie.js";
import { insertMetadata } from "../insert/insertMetadata.js";

const PROV_BASE  = 1_000_000_000;
const PROV_LIMIT = 2_000_000_000 - 1;

async function genProvisionalId(db) {
    for (let i = 0; i < 8; i++) {
        const id = PROV_BASE + Math.floor(Math.random() * (PROV_LIMIT - PROV_BASE + 1));
        const { rows } = await db.query("SELECT 1 FROM movies WHERE id=$1", [id]);
        if (rows.length === 0) return id;
    }
    throw new Error("Could not generate a unique provisional id");
}

function cleanFrTitle(raw) {
    return (raw || "")
        .replace(/\bV\.?F\.?(\s*Q|O?F)?\b/ig, "")
        .replace(/\bV\.?O\.?(S?T\.)?\b/ig, "")
        .replace(/\s*\(\s*version\s+fran(?:ç|c)aise\s*\)\s*/ig, "")
        .replace(/\s*\(\s*vf(?:of)?\s*\)\s*/ig, "")
        .replace(/\s+vf(?:of)?\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

async function hasUnaccent(db) {
    try { await db.query("SELECT unaccent('é')"); return true; } catch { return false; }
}

/** Find an existing movie, preferring exact FR-title match, then EN/original title.
 * Uses the SAME year-window: release_date BETWEEN (yearHint-1) and (yearHint+1).
 * Ordering preference: FR match first → non-provisional → has tmdb_id → popularity.
 */
async function findExistingByTitle(db, { title, yearHint }) {
    const cleaned = cleanFrTitle(title);
    const useUnaccent = await hasUnaccent(db);
    const norm = (col) => useUnaccent ? `unaccent(lower(${col}))` : `lower(${col})`;
    const p1   = useUnaccent ? "unaccent(lower($1))" : "lower($1)";

    const whereParts = [
        `(${norm("m.fr_title")} = ${p1} OR ${norm("m.title")} = ${p1})`
    ];
    const params = [cleaned];

    if (yearHint) {
        whereParts.push(`m.release_date BETWEEN ($2||'-01-01')::date AND ($3||'-12-31')::date`);
        params.push(yearHint - 1, yearHint + 1);
    }

    const sql = `
        SELECT
            m.id,
            (${norm("m.fr_title")} = ${p1}) AS fr_match,
            (${norm("m.title")}    = ${p1}) AS en_match
        FROM movies m
        WHERE ${whereParts.join(" AND ")}
        ORDER BY
            fr_match DESC,                     -- prefer exact FR title match
            m.id
        LIMIT 1
    `;

    const { rows } = await db.query(sql, params);
    return rows[0]?.id ?? null;
}

/** Reuse an existing placeholder by normalized title or source_url (safe NULL handling). */
async function reuseExistingPlaceholder(db, { title, baseFilmUrl, yearHint }) {
    const useUnaccent = await hasUnaccent(db);
    const norm  = (col) => useUnaccent ? `unaccent(lower(${col}))` : `lower(${col})`;
    const p1    = useUnaccent ? "unaccent(lower($1))" : "lower($1)";
    const sUrl2 = "$2::text"; // cast avoids "could not determine data type of parameter $2"

    const whereParts = [
        `provisional = TRUE`,
        `(${norm("fr_title")} = ${p1} OR ${norm("title")} = ${p1} OR (COALESCE(${sUrl2}, '') <> '' AND source_url = ${sUrl2}))`,
    ];
    const params = [cleanFrTitle(title), (baseFilmUrl ?? null)];

    if (yearHint) {
        whereParts.push(`release_date BETWEEN ($3||'-01-01')::date AND ($4||'-12-31')::date`);
        params.push(yearHint - 1, yearHint + 1);
    }

    const sql = `
    SELECT id
    FROM movies
    WHERE ${whereParts.join(" AND ")}
    ORDER BY id DESC
    LIMIT 1
  `;
    const { rows } = await db.query(sql, params);
    return rows[0]?.id ?? null;
}

export async function ensureMovieIdOrPlaceholder(db, { title, yearHint, baseFilmUrl, extraQueries = [] }) {
    const cleanedTitle = cleanFrTitle(title);

    // 0) EXACT FR (or EN/original) title match first — this is the key fix
    const hit = await findExistingByTitle(db, { title: cleanedTitle, yearHint });
    if (hit) return hit;

    // 1) Your original “local by year” block (kept verbatim)
    if (yearHint) {
        const { rows } = await db.query(
            `SELECT id FROM movies
             WHERE (fr_title=$1 OR title=$1)
               AND release_date BETWEEN ($2||'-01-01')::date AND ($3||'-12-31')::date
             ORDER BY popularity DESC NULLS LAST
             LIMIT 1`,
            [cleanedTitle, yearHint - 1, yearHint + 1]
        );
        if (rows[0]) return rows[0].id;
    }

    // 2) TMDb search (include cleaned FR title first)
    const qs = [...new Set([cleanedTitle, ...extraQueries])];
    for (const q of qs) {
        const m =
            (await searchMovie(q, yearHint,   { strict: true, tol: 1, allowNoYearFallback: false })) ||
            (await searchMovie(q, yearHint-1, { strict: true, tol: 0 })) ||
            (await searchMovie(q, yearHint+1, { strict: true, tol: 0 }));
        if (m?.id) {
            await insertMetadata(m.id, cleanedTitle);
            return m.id;
        }
    }

    // 3) Reuse an existing placeholder (title/source_url), with safe casts
    const reuseId = await reuseExistingPlaceholder(db, {
        title: cleanedTitle,
        baseFilmUrl: baseFilmUrl ? String(baseFilmUrl) : null,
        yearHint,
    });
    if (reuseId) return reuseId;

    // 4) Create new placeholder
    const tempId = await genProvisionalId(db);
    await db.query(
        `INSERT INTO movies (id, fr_title, title, provisional, source_url)
       VALUES ($1, $2, $2, TRUE, $3)
       ON CONFLICT (id) DO NOTHING`,
        [tempId, cleanedTitle, baseFilmUrl ? String(baseFilmUrl) : null]
    );
    return tempId;
}
