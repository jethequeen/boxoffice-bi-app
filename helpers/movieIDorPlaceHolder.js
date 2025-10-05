// helpers/ensureMovieIdOrPlaceholder.js
import { searchMovie } from "../insert/searchMovie.js";
import { insertMetadata } from "../insert/insertMetadata.js";

const PROV_BASE  = 1_000_000_000;
const PROV_LIMIT = 1_999_999_999;

/* ---------- NORMALIZATION (JS side) ---------- */
function cleanFrTitle(raw) {
    return (raw || "")
        // remove VF/VO markers
        .replace(/\bV\.?F\.?(\s*Q|O?F)?\b/ig, "")
        .replace(/\bV\.?O\.?(S?T\.)?\b/ig, "")
        .replace(/\s*\(\s*version\s+fran(?:ç|c)aise\s*\)\s*/ig, "")
        .replace(/\s*\(\s*vf(?:of)?\s*\)\s*/ig, "")
        .replace(/\s+vf(?:of)?\s*$/i, "")
        .trim();
}
function normTitleJS(s = "") {
    // normalize Unicode, remove zero-widths, map NBSP to space, collapse spaces, toLower
    return s
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")          // zero-widths
        .replace(/\u00A0/g, " ")                         // NBSP -> space
        .replace(/[“”„‟]/g, '"').replace(/[’‘‛]/g, "'") // smart quotes
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim();
}

/* ---------- UTIL ---------- */
async function genProvisionalId(db) {
    for (let i = 0; i < 8; i++) {
        const id = PROV_BASE + Math.floor(Math.random() * (PROV_LIMIT - PROV_BASE + 1));
        const { rows } = await db.query("SELECT 1 FROM movies WHERE id=$1", [id]);
        if (rows.length === 0) return id;
    }
    throw new Error("Could not generate a unique provisional id");
}

async function hasUnaccent(db) {
    try { await db.query("SELECT unaccent('é')"); return true; } catch { return false; }
}

/**
 * FLOW:
 * 1) Try TMDb (your searchMovie). If found → ensure metadata → return tmdbId.
 * 2) Else try to reuse by exact/normalized fr_title/title (handles Unicode twins).
 * 3) Else create a provisional row (protected by an advisory lock to avoid races).
 *
 * Concurrency: we take pg_advisory_xact_lock on normalized title so only one
 * transaction can decide/insert for that title at a time.
 */
export async function ensureMovieIdOrPlaceholder(
    db,
    { title, yearHint, baseFilmUrl, extraQueries = [] }
) {
    const frTitleRaw = cleanFrTitle(title);
    if (!frTitleRaw) throw new Error("ensureMovieIdOrPlaceholder: missing frTitle/title");
    const normKey = normTitleJS(frTitleRaw); // use as our lock key + SQL param

    // Start a short transaction to sequence operations and hold the lock.
    await db.query("BEGIN");

    try {
        // ---- (A) lock on normalized title (prevents duplicate provisional inserts) ----
        // hashtext($1) returns an int4; advisory lock is per transaction.
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [normKey]);

        // ---- (B) TMDb first (quick—does not create duplicates) ----
        const queries = [...new Set([frTitleRaw, ...extraQueries.filter(Boolean)])];
        const years   = yearHint != null ? [yearHint, yearHint - 1, yearHint + 1] : [undefined];

        for (const q of queries) {
            for (const y of years) {
                try {
                    const m = await searchMovie(q, y, { strict: true, tol: 1, allowNoYearFallback: false });
                    if (m?.id) {
                        await insertMetadata(m.id, frTitleRaw);
                        await db.query("COMMIT");
                        return Number(m.id);
                    }
                } catch { /* ignore and continue */ }
            }
        }

        // ---- (C) Reuse existing by EXACT or NORMALIZED match (handles NFC/NFD, NBSP, quotes) ----
        const useUnaccent = await hasUnaccent(db);
        const sqlNorm = (col) => {
            // lower( … collapse spaces … map nbsp to space … unify quotes … [unaccent] … )
            const base =
                `lower(
           regexp_replace(
             translate(translate(${col}, E'\\u00A0', ' '), '’‘‛“”„‟', '''''''"""""'),
             '\\s+', ' ', 'g'
           )
         )`;
            return useUnaccent ? `lower(regexp_replace(unaccent(${base}), '\\s+', ' ', 'g'))` : base;
        };

        const findSql = `
      SELECT id
      FROM movies
      WHERE
        -- byte-exact first
        fr_title = $1 OR title = $1
        OR ${sqlNorm("fr_title")} = $2
        OR ${sqlNorm("title")}    = $2
      ORDER BY id
      LIMIT 1
    `;
        const found = await db.query(findSql, [frTitleRaw, normKey]);
        if (found.rowCount) {
            await db.query("COMMIT");
            return Number(found.rows[0].id);
        }

        // ---- (D) Create provisional row (still under the lock) ----
        const tempId = await genProvisionalId(db);
        await db.query(
            `INSERT INTO movies (id, fr_title, title, provisional, source_url)
       VALUES ($1, $2, $2, TRUE, $3)
       ON CONFLICT (id) DO NOTHING`,
            [tempId, frTitleRaw, baseFilmUrl ?? null]
        );

        await db.query("COMMIT");
        return tempId;

    } catch (e) {
        await db.query("ROLLBACK");
        throw e;
    }
}
