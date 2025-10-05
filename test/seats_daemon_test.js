// test/smoke_fetch_providers_once.js
import { getClient } from "../db/client.js";
import {
    getShowtimesKeyFromTheatreUrl,
    fetchSeatsForShowtime,
    upsertSeatsSoldFromMeasurement,
} from "../insert/insertAuditorium_cineplex.js";
import { cinemathequeScrapeSeats } from "../insert/seats_sold_Cinematheque_quebecoise.js";

const TZ = "America/Toronto";
function fmtLocalDateTime(iso) {
    const d = new Date(iso);
    const df = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    const tf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
    const [{ value: Y }, , { value: M }, , { value: D }] = df.formatToParts(d);
    const [{ value: HH }, , { value: mm }] = tf.formatToParts(d);
    return { local_date: `${Y}-${M}-${D}`, local_time: `${HH}:${mm}` };
}
// put near the top
const WINDOW_BACK  = "12 hours";   // how far back we’ll still consider
const WINDOW_AHEAD = "14 days";    // how far forward
const PROVIDER_CQ  = `(t.name ILIKE '%cinémathèque québécoise%' OR t.name ILIKE '%cinematheque quebecoise%')`;

// optional: pretty print seconds delta
function humanDeltaSec(sec) {
    const s = Math.round(sec);
    const sign = s < 0 ? "-" : "+";
    const a = Math.abs(s);
    const h = Math.floor(a / 3600);
    const m = Math.floor((a % 3600) / 60);
    const r = a % 60;
    return `${sign}${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
}

async function pickOne(client, provider) {
    const isCQ = provider === "cinematheque";

    const sql = `
    SELECT
      s.id AS showing_id,
      s.movie_id,
      s.theater_id,
      COALESCE(m.fr_title, m.title) AS movie_title,
      s.start_at,
      t.name AS theater_name,
      t.theater_api_id,
      t.showings_url,
      -- absolute distance (seconds) to now()
      ABS(EXTRACT(EPOCH FROM (s.start_at - now()))) AS dist_sec
    FROM showings s
    JOIN theaters t ON t.id = s.theater_id
    JOIN movies   m ON m.id = s.movie_id
    WHERE s.seats_sold IS NULL
      AND s.start_at BETWEEN (now() - interval '${WINDOW_BACK}')
                         AND (now() + interval '${WINDOW_AHEAD}')
      AND ${
        isCQ
            ? PROVIDER_CQ
            : `t.theater_api_id IS NOT NULL AND t.showings_url IS NOT NULL`
    }
    ORDER BY
      dist_sec,     -- closest to now, past or future
      s.start_at    -- tie-break: earliest
    LIMIT 1
  `;

    const { rows } = await client.query(sql);
    const row = rows[0] || null;

    // optional: log the distance you’re getting
    if (row) {
        console.log(`[pick:${provider}] closest = ${row.theater_name} • ${row.movie_title} • ${new Date(row.start_at).toISOString()} • Δ=${humanDeltaSec(row.dist_sec)}`);
    }
    return row;
}


async function simulateUpsert(client, measurement) {
    // run upsert in a transaction and roll back so DB is untouched
    await client.query("BEGIN");
    try {
        const res = await upsertSeatsSoldFromMeasurement({ pgClient: client, measurement });
        // Don’t persist:
        await client.query("ROLLBACK");
        return res;
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    }
}

async function main() {
    const client = getClient();
    await client.connect();

    try {
        const cq = await pickOne(client, "cinematheque");
        const cx = await pickOne(client, "cineplex");

        if (!cq) console.log("[pick] No Cinemathèque candidate found.");
        if (!cx) console.log("[pick] No Cineplex candidate found.");

        // ---- CINÉMATHÈQUE ----
        if (cq) {
            const { local_date, local_time } = fmtLocalDateTime(cq.start_at);
            console.log("\n[CINÉMATHÈQUE] Candidate:");
            console.log(`- Theater: ${cq.theater_name}`);
            console.log(`- Title  : ${cq.movie_title}`);
            console.log(`- When   : ${local_date} ${local_time} (showing_id=${cq.showing_id})`);

            try {
                const rec = await cinemathequeScrapeSeats({
                    dateISO: local_date,
                    hhmm: local_time,
                    title: cq.movie_title,
                });

                console.log(`[scrape] Seats remaining=${rec.seats_remaining}, Auditorium=${rec.auditorium}`);

                const preview = await simulateUpsert(client, {
                    showing_id: cq.showing_id,
                    theater_id: cq.theater_id,
                    movie_id: cq.movie_id,
                    auditorium: rec.auditorium,
                    seats_remaining: rec.seats_remaining,
                    source: "cinematheque",
                });

                console.log("[preview upsert] (rolled back)");
                console.log({
                    theater_id: cq.theater_id,
                    movie_id: cq.movie_id,
                    screen_id: preview.screen_id,
                    auditorium: preview.auditorium,
                    capacity: preview.capacity,
                    remaining: preview.remaining,
                    seats_sold: preview.seats_sold,
                });
            } catch (e) {
                console.warn("[cinematheque] failed:", e.message);
            }
        }

        // ---- CINEPLEX ----
        if (cx) {
            const { local_date, local_time } = fmtLocalDateTime(cx.start_at);
            console.log("\n[CINEPLEX] Candidate:");
            console.log(`- Theater: ${cx.theater_name}`);
            console.log(`- Title  : ${cx.movie_title}`);
            console.log(`- When   : ${local_date} ${local_time} (showing_id=${cx.showing_id})`);

            try {
                const key = await getShowtimesKeyFromTheatreUrl(cx.showings_url);
                const info = await fetchSeatsForShowtime({
                    locationId: cx.theater_api_id,
                    date: local_date,
                    movieTitle: cx.movie_title,
                    showtime: local_time,
                    lang: "fr",
                    showtimesKey: key,
                });

                const measurement = {
                    showing_id: cx.showing_id,
                    theater_id: cx.theater_id,
                    movie_id: cx.movie_id,
                    auditorium: (info.auditorium || "").trim(),
                    seats_remaining: info.seatsRemaining ?? null,
                    source: "cineplex",
                };

                console.log(`[scrape] Seats remaining=${measurement.seats_remaining}, Auditorium=${measurement.auditorium}`);

                const preview = await simulateUpsert(client, measurement);

                console.log("[preview upsert] (rolled back)");
                console.log({
                    theater_id: cx.theater_id,
                    movie_id: cx.movie_id,
                    screen_id: preview.screen_id,
                    auditorium: preview.auditorium,
                    capacity: preview.capacity,
                    remaining: preview.remaining,
                    seats_sold: preview.seats_sold,
                });
            } catch (e) {
                console.warn("[cineplex] failed:", e.message);
            }
        }
    } finally {
        await client.end();
    }
}

main().catch((e) => {
    console.error("Fatal:", e.message || e);
    process.exit(1);
});
