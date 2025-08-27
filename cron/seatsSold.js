// cron/seatsSold_daemon.js
import dotenv from "dotenv";
dotenv.config();

import { getClient } from "../db/client.js";
import { upsertSeatsSold, getShowtimesKeyFromTheatreUrl } from "../insert/insertAuditorium_cineplex.js";

const TZ = "America/Toronto";

// --- timing window config ---
// We'll scrape a show exactly in the minute after it hits start_at + 14m.
// If you want a wider pre-close window, increase WINDOW_SEC (e.g., 90).
const LEAD_IN_SEC = 13 * 60; // 13 minutes after start
const WINDOW_SEC  = 60;      // 60-second wide window

// --- simple in-memory key cache per theater ---
const keyCache = new Map(); // theater_id -> { key, fetchedAt, theatreUrl, locationId }

/**
 * Ensure we have a showtimes key for this theater, caching it to avoid many Puppeteer launches.
 */
async function ensureKeyForTheater(client, theater_id) {
    const cached = keyCache.get(theater_id);
    if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) {
        return cached; // reuse up to 15 minutes; adjust as desired
    }
    const q = await client.query(
        `SELECT theater_api_id, showings_url FROM theaters WHERE id = $1 LIMIT 1`,
        [theater_id]
    );
    if (q.rowCount === 0) throw new Error(`theater_id=${theater_id} not found in theaters`);
    const { theater_api_id: locationId, showings_url: theatreUrl } = q.rows[0];
    if (!locationId || !theatreUrl) throw new Error(`theater_id=${theater_id} missing api_id/showings_url`);
    const key = await getShowtimesKeyFromTheatreUrl(theatreUrl);
    const val = { key, fetchedAt: Date.now(), theatreUrl, locationId };
    keyCache.set(theater_id, val);
    return val;
}

/**
 * Find *all* showings whose measurement window is "now".
 * Window: [start_at + LEAD_IN_SEC, start_at + LEAD_IN_SEC + WINDOW_SEC)
 * And only Cineplex-mapped theaters, and only if seats_sold is still NULL.
 */
async function findDueShowings(client) {
    const q = await client.query(
        `
    SELECT
      s.id                AS showing_id,
      s.movie_id,
      s.theater_id,
      COALESCE(m.fr_title, m.title) AS movie_title,
      (s.start_at + make_interval(secs => $1)) AS window_start,
      (s.start_at + make_interval(secs => $1 + $2)) AS window_end,
      to_char((s.start_at AT TIME ZONE $3), 'YYYY-MM-DD') AS local_date,
      to_char((s.start_at AT TIME ZONE $3), 'HH24:MI')    AS local_time
    FROM showings s
    JOIN theaters t ON t.id = s.theater_id
    JOIN movies   m ON m.id = s.movie_id
    WHERE t.theater_api_id IS NOT NULL
      AND s.seats_sold IS NULL
      AND now() >= (s.start_at + make_interval(secs => $1))
      AND now() <  (s.start_at + make_interval(secs => $1 + $2))
    ORDER BY (s.start_at + make_interval(secs => $1)) ASC
    `,
        [LEAD_IN_SEC, WINDOW_SEC, TZ]
    );
    return q.rows;
}

/**
 * Process a single showing: ensure key, call upsert.
 */
async function processShowing(client, row) {
    const { theater_id, movie_id, movie_title, local_date, local_time } = row;
    const { key, locationId } = await ensureKeyForTheater(client, theater_id);

    // Call your upsert WITHOUT any timing logic inside.
    return await upsertSeatsSold({
        pgClient: client,
        movie_id,
        theater_id,
        local_date,
        local_time,
        movieTitle: movie_title,
        locationId,
        showtimesKey: key,
    });
}

async function tickOnce() {
    const client = getClient();
    await client.connect();
        const due = await findDueShowings(client);
        if (due.length === 0) {
            console.log(`[seatsSold] ${new Date().toISOString()}: no due showings in window.`);
            return;
        }

        console.log(`[seatsSold] ${new Date().toISOString()}: processing ${due.length} showings...`);
        // Process sequentially to be gentle with Cineplex API (or add small concurrency if you prefer).
        for (const row of due) {
            try {
                const res = await processShowing(client, row);
                console.log(`[seatsSold] OK ${row.showing_id} →`, {
                    theater_id: res.theater_id,
                    movie_id: res.movie_id,
                    screen_id: res.screen_id,
                    auditorium: res.auditorium,
                    seats_sold: res.seats_sold,
                    start_at: res.start_at
                });
            } catch (e) {
                console.error(`[seatsSold] FAIL ${row.showing_id}:`, e.message);
            }
        }
        await client.end();
}

function main() {
    // Run immediately, then every 60 seconds.
    tickOnce();
    setInterval(tickOnce, 60 * 1000);
}

main();
