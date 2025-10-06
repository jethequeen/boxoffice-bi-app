// test/daemon_like_preview_loop.js
// Preview runner that mirrors the real daemon, but rolls back all DB writes.
// Shows priority execution (Ciné Entreprise first) and provider-specific logic.

import { setGlobalDispatcher, Agent } from "undici";
import { getClient } from "../db/client.js";
import { getShowtimesKeyFromTheatreUrl, upsertSeatsSoldFromMeasurement } from "../insert/insertAuditorium_cineplex.js";
import { getSeatsByTheater, classifyTheaterName } from "../scraper/provider_registry.js";

const SKIP_CINEPLEX = process.env.SKIP_CINEPLEX === '1';

/* ---------- Config (mirror daemon) ---------- */
const TZ                 = "America/Toronto";
const RESYNC_MIN         = 180;    // every 3h
const LOOKAHEAD_H        = 8;      // queue shows up to 8h ahead
const BACKPAD_MIN        = 15;     // include shows that started in the last 15min
const SCRAPE_CONC        = 6;      // scraping concurrency
const KEY_CACHE_TTL_MS   = 60 * 60 * 1000;
const QUIET_START        = "01:00";
const QUIET_END          = "10:00";

const PROVIDER_TIMING = {
    cinematheque:  { offsetSec: -7 * 60, windowAfterSec: 2 * 60 },
    cineplex:      { offsetSec: 12 * 60, windowAfterSec: 3 * 60 },
    webdev:        { offsetSec:  8 * 60, windowAfterSec: 3 * 60 },
    // NEW: CE closes right at showtime; scrape shortly before with a tiny window
    cineentreprise:{ offsetSec: -7 * 60, windowAfterSec: 1 * 60 },
};
const DEFAULT_TIMING = { offsetSec: 12 * 60, windowAfterSec: 5 * 60 };

/* ---------- HTTP keep-alive (same as daemon) ---------- */
setGlobalDispatcher(new Agent({ connections: 16, pipelining: 1, keepAliveTimeout: 30_000 }));

/* ---------- p-limit ---------- */
function pLimit(n){ let active=0,q=[];
    const run=async(fn,res,rej)=>{active++;try{res(await fn())}catch(e){rej(e)}finally{active--; if(q.length){const [f,r,j]=q.shift();run(f,r,j)}}};
    return (fn)=>new Promise((res,rej)=>{active<n?run(fn,res,rej):q.push([fn,res,rej])});
}
const scrapeLimit = pLimit(SCRAPE_CONC);

/* ---------- Min-heap ---------- */
class MinHeap{
    constructor(){this.a=[]}
    push(x){this.a.push(x);this._up(this.a.length-1)}
    peek(){return this.a[0]||null}
    pop(){if(!this.a.length)return null;const t=this.a[0],l=this.a.pop();if(this.a.length){this.a[0]=l;this._down(0)}return t}
    _up(i){for(;i>0;){const p=(i-1>>1); if(this.a[p].ts<=this.a[i].ts) break; [this.a[p],this.a[i]]=[this.a[i],this.a[p]]; i=p;}}
    _down(i){for(;;){const l=i*2+1,r=l+1;let s=i; if(l<this.a.length && this.a[l].ts<this.a[s].ts) s=l; if(r<this.a.length && this.a[r].ts<this.a[s].ts) s=r; if(s===i) break; [this.a[s],this.a[i]]=[this.a[i],this.a[s]]; i=s;}}
}

/* ---------- Helpers ---------- */
function inQuietHours(now=new Date()){
    const fmt = new Intl.DateTimeFormat("en-CA",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
    const [{value:HH},, {value:mm}] = fmt.formatToParts(now);
    const cur = `${HH}:${mm}`;
    return (cur >= QUIET_START && cur < QUIET_END);
}
function fmtLocalDateTime(iso){
    const d=new Date(iso);
    const df=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
    const tf=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
    const [{value:Y},, {value:M},, {value:D}] = df.formatToParts(d);
    const [{value:HH},, {value:mm}] = tf.formatToParts(d);
    return { local_date:`${Y}-${M}-${D}`, local_time:`${HH}:${mm}` };
}

/* ---------- State ---------- */
const heap = new MinHeap();
const theaterKeyCache = new Map(); // theater_id -> { key, locationId, fetchedAt }

/* ---------- DB sync: build queue (same logic as daemon) ---------- */
async function syncFromDb(pg){
    const q = await pg.query(`
        SELECT
            s.id                          AS showing_id,
            s.movie_id,
            s.theater_id,
            COALESCE(m.fr_title, m.title) AS movie_title,
            s.start_at,
            t.theater_api_id              AS location_id,
            t.showings_url                AS theatre_url,
            t.name                        AS theater_name
        FROM showings s
                 JOIN theaters t ON t.id = s.theater_id
                 JOIN movies   m ON m.id = s.movie_id
        WHERE s.seats_sold IS NULL
          AND s.start_at BETWEEN (now() - make_interval(mins => $1))
            AND (now() + make_interval(hours => $2))
        ORDER BY s.start_at
    `, [BACKPAD_MIN, LOOKAHEAD_H]);

    let enq = 0;
    const nowMs = Date.now();

    for (const r of q.rows) {
        const name = r.theater_name || "";
        const provider = classifyTheaterName(name) || "webdev";

        // Prefetch key for Cineplex
        if (provider === "cineplex") {
            const cached = theaterKeyCache.get(r.theater_id);
            if (!cached || (nowMs - cached.fetchedAt) > KEY_CACHE_TTL_MS) {
                if (!r.theatre_url || !r.location_id) continue;
                const key = await getShowtimesKeyFromTheatreUrl(r.theatre_url);
                theaterKeyCache.set(r.theater_id, { key, locationId: r.location_id, fetchedAt: Date.now() });
            }
        }

        const { offsetSec, windowAfterSec } = PROVIDER_TIMING[provider] || DEFAULT_TIMING;
        const startMs   = new Date(r.start_at).getTime();
        const trigger   = startMs + offsetSec * 1000;
        const windowEnd = trigger + windowAfterSec * 1000;

        if (Date.now() > windowEnd) continue; // don’t enqueue expired windows

        const { local_date, local_time } = fmtLocalDateTime(r.start_at);
        const payload = {
            provider,
            showing_id: r.showing_id,
            movie_id:   r.movie_id,
            theater_id: r.theater_id,
            theater_name: name,
            movieTitle: r.movie_title,
            local_date,
            local_time,
        };
        if (provider === "cineplex") {
            const got = theaterKeyCache.get(r.theater_id);
            if (!got) continue;
            payload.locationId   = got.locationId;
            payload.showtimesKey = got.key;
        }
        heap.push({ ts: trigger, windowEnd, params: payload });
        enq++;
    }
    console.log(`[sync-preview] queued ${enq}/${q.rowCount} (heap=${heap.a.length})`);
}

/* ---------- Tick: run due items (preview upsert, with CE seat_count mapping) ---------- */
async function tick(pg){
    const now = Date.now();
    const due = [];
    while (heap.peek() && heap.peek().ts <= now) {
        const task = heap.pop();
        if (now <= task.windowEnd) due.push(task.params);
    }
    if (!due.length) return;

    // Priority: CE first, then Cineplex, then the rest
    const prio = { cineentreprise: 0, cineplex: 1, cinematheque: 2, webdev: 3 };
    due.sort((a, b) => (prio[a.provider] ?? 99) - (prio[b.provider] ?? 99));

    let ok = 0, fail = 0;
    await Promise.allSettled(due.map(p => scrapeLimit(async () => {
        try {
            const rec = await getSeatsByTheater(
                p.theater_name,
                { dateISO: p.local_date, hhmm: p.local_time, title: p.movieTitle },
                p.provider === "cineplex" ? {
                    locationId: p.locationId,
                    showtimesKey: p.showtimesKey,
                    movieTitle: p.movieTitle
                } : undefined
            );

            // Preview: never commit anything
            await pg.query("BEGIN");

            if ((rec?.source ?? p.provider) === "cineentreprise") {
                // CE path: map screen by seat_count (capacity), then compute seats_sold
                const capacity = rec?.sellable ?? rec?.raw?.sellable ?? null;
                const remaining = rec?.seats_remaining ?? null;

                let chosen = null;
                if (capacity != null) {
                    const s = await pg.query(
                        `SELECT id AS screen_id, name, seat_count
               FROM screens
              WHERE theater_id = $1 AND seat_count = $2
              ORDER BY name
              LIMIT 1`,
                        [p.theater_id, capacity]
                    );
                    chosen = s.rows[0] || null;
                }

                const seats_sold = (chosen && remaining != null)
                    ? Math.max(0, chosen.seat_count - remaining)
                    : null;

                console.log(
                    `[ok/CE] ${p.theater_name} • ${p.movieTitle} • ${p.local_date} ${p.local_time} ` +
                    `→ capacity=${capacity} remaining=${remaining} ` +
                    (chosen
                        ? `screen="${chosen.name}"(#${chosen.screen_id}) sold=${seats_sold}`
                        : `screen=? (no match for capacity)`)
                );
            } else {
                // Non-CE path: use existing helper (still rolled back)
                const preview = await upsertSeatsSoldFromMeasurement({
                    pgClient: pg,
                    measurement: {
                        showing_id:      p.showing_id,
                        movie_id:        p.movie_id,
                        theater_id:      p.theater_id,
                        auditorium:      rec?.auditorium ?? null,
                        seats_remaining: rec?.seats_remaining ?? null,
                        measured_at:     rec?.measured_at ?? new Date().toISOString(),
                        source:          rec?.source ?? p.provider,
                    },
                });

                console.log(
                    `[ok/${p.provider}] ${p.theater_name} • ${p.movieTitle} • ${p.local_date} ${p.local_time} ` +
                    `→ auditorium=${preview.auditorium} remaining=${preview.remaining} ` +
                    `capacity=${preview.capacity} sold=${preview.seats_sold} screen_id=${preview.screen_id ?? "?"}`
                );
            }

            await pg.query("ROLLBACK");
            ok++;
        } catch (e) {
            console.warn(`[fail/${p.provider}] ${p.theater_name} • ${p.movieTitle} • ${p.local_date} ${p.local_time} :: ${e?.message || e}`);
            try { await pg.query("ROLLBACK"); } catch {}
            fail++;
        }
    })));

    console.log(`[tick-preview] sampled ${due.length} | ok=${ok} fail=${fail}`);
}

/* ---------- Main loop ---------- */
async function main(){
    const pg = getClient();
    await pg.connect();

    console.log(`[start] preview daemon: resync=${RESYNC_MIN}m, lookahead=${LOOKAHEAD_H}h, tick=1m (rollback mode)`);

    // initial sync
    if (!inQuietHours()) await syncFromDb(pg);

    // RESYNC every 3h
    const resyncTimer = setInterval(() => {
        if (!inQuietHours()) syncFromDb(pg).catch(e => console.error("[sync-preview] error", e?.message || e));
    }, RESYNC_MIN * 60 * 1000);

    // TICK every minute
    const tickTimer = setInterval(() => {
        if (!inQuietHours()) tick(pg).catch(e => console.error("[tick-preview] error", e?.message || e));
    }, 60 * 1000);

    // graceful shutdown
    const shutdown = async () => {
        clearInterval(resyncTimer);
        clearInterval(tickTimer);
        try { await pg.end(); } finally { process.exit(0); }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch(e => {
    console.error("Fatal:", e?.message || e);
    process.exit(1);
});
