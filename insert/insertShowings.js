// insert/insertPerformances.js
import { getClient } from "../db/client.js";

/**
 * Ensures a theater exists and returns its id.
 * Requires a UNIQUE on theaters(name).
 */
async function ensureTheater(client, name, company = null, screens = null) {
    const res = await client.query(
        `
            INSERT INTO theaters (name, company, screens)
            VALUES ($1, $2, $3)
            ON CONFLICT (name) DO UPDATE
                SET
                    company = COALESCE(theaters.company, EXCLUDED.company),
                    screens = COALESCE(theaters.screens, EXCLUDED.screens)
            RETURNING id
        `,
        [name, company, screens]
    );
    return res.rows[0]?.id;
}

/**
 * Insert all showings for one movie (idempotent).
 * blocks: [{ dateISO: 'YYYY-MM-DD', theater: 'Name', times: ['13:05','16:05', ...] }]
 * Returns number of rows inserted.
 */
/** Insert all showings for one movie (idempotent) */
export async function insertShowingsForMovie(tmdbId, blocks) {
    const client = getClient();
    await client.connect();
    let inserted = 0;

    try {
        await client.query("BEGIN");
        const theaterCache = new Map();
        const values = [];
        const placeholders = [];

        for (const b of blocks) {
            if (!b?.dateISO || !b?.theater || !Array.isArray(b.times)) continue;

            let theaterId = theaterCache.get(b.theater);
            if (!theaterId) {
                theaterId = await ensureTheater(client, b.theater, b.chain ?? null, b.screenCount ?? null);
                if (!theaterId) continue;
                theaterCache.set(b.theater, theaterId);
            }

            for (const hhmm of b.times) {
                if (!/^\d{1,2}:\d{2}$/.test(hhmm)) continue;
                const base = values.length;
                placeholders.push(
                    `($${base + 1}, $${base + 2},
             ( ($${base + 3}::date + $${base + 4}::time) AT TIME ZONE 'America/Toronto' ),
             $${base + 3}::date)`
                );
                values.push(tmdbId, theaterId, b.dateISO, hhmm);
            }
        }

        if (placeholders.length) {
            const sql = `
        INSERT INTO showings (movie_id, theater_id, start_at, date)
        VALUES ${placeholders.join(",")}
        ON CONFLICT (movie_id, theater_id, start_at, date) DO NOTHING
        RETURNING id
      `;
            const res = await client.query(sql, values);
            inserted = res.rowCount || 0;
        }

        await client.query("COMMIT");
        return inserted;
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ insertShowingsForMovie error:", e);
        throw e;
    } finally {
        await client.end();
    }
}
