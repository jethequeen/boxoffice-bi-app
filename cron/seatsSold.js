import { setGlobalDispatcher, Agent } from "undici";
import { getClient } from "../db/client.js";
import {
    getShowtimesKeyFromTheatreUrl,
    scrapeSeatsOnly as scrapeSeatsOnlyCineplex,
    upsertSeatsSoldFromMeasurement
} from "../insert/insertAuditorium_cineplex.js";
import { cinemathequeScrapeSeats } from "../insert/seats_sold_Cinematheque_quebecoise.js";

/* ---------- Hardcoded config (no envs) ---------- */
const TZ               = "America/Toronto";
const RESYNC_MIN       = 180;     // read DB every 3h to rebuild queue
const LOOKAHEAD_H      = 8;       // queue shows up to 8h ahead
const BACKPAD_MIN      = 15;      // include shows that started in the last 15min
const FLUSH_MIN        = 60;      // flush every 60 min
const FLUSH_BATCH      = 100;     // or when we have 100+ measurements
const SCRAPE_CONC      = 6;       // scraping concurrency
const UPSERT_CONC      = 8;       // DB upsert concurrency
const KEY_CACHE_TTL_MS = 60*60*1000; // 60min
const QUIET_START      = "01:00"; // inclusive
const QUIET_END        = "10:00"; // exclusive
const LOG_LEVEL        = "info";  // "debug" for chattier logs

/** Provider-specific timing (seconds).
 *  trigger = show.start_at + offsetSec
 *  accept window: [trigger .. trigger + windowAfterSec]
 */
const PROVIDER_TIMING = {
    cinematheque: { offsetSec: -3 * 60,  windowAfterSec: 2 * 60 },  // run 3m before; accept another 2 minutes
    cineplex:     { offsetSec: 12 * 60,  windowAfterSec: 3 * 60 },  // run 12m after; accept another 3 minutes
};
// default fallback if a theatre doesn’t match either bucket
const DEFAULT_TIMING = { offsetSec: 12 * 60, windowAfterSec: 5 * 60 };

/* ---------- HTTP keep-alive ---------- */
setGlobalDispatcher(new Agent({ connections: 16, pipelining: 1, keepAliveTimeout: 30_000 }));

/* ---------- p-limit ---------- */
function pLimit(n){ let active=0,q=[]; const run=async(fn,res,rej)=>{active++;try{res(await fn())}catch(e){rej(e)}finally{active--; if(q.length){const [f,r,j]=q.shift();run(f,r,j)}}}; return (fn)=>new Promise((res,rej)=>{active<n?run(fn,res,rej):q.push([fn,res,rej])});}
const scrapeLimit = pLimit(SCRAPE_CONC);
const upsertLimit = pLimit(UPSERT_CONC);

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
const heap         = new MinHeap(); // due tasks
const measurements = [];            // buffered scraped measurements
const failures     = [];            // optional diagnostics
const theaterKeyCache = new Map();  // theater_id -> { key, locationId, fetchedAt }

/* ---------- DB sync: build queue ---------- */
async function syncFromDb() {
    const client = getClient();
    await client.connect();
    try {
        const q = await client.query(`
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

        // prefetch Cineplex keys where applicable
        const nowMs = Date.now();
        let enq = 0;
        for (const r of q.rows) {
            const isCinematheque = /cinémath[eè]que|cinematheque/i.test(r.theater_name || "");
            const provider = isCinematheque ? "cinematheque" : "cineplex";

            // Cineplex needs an API key; Cinemathèque does not
            if (provider === "cineplex") {
                const cached = theaterKeyCache.get(r.theater_id);
                if (!cached || (nowMs - cached.fetchedAt) > KEY_CACHE_TTL_MS) {
                    if (!r.theatre_url || !r.location_id) {
                        // If a Cineplex theater lacks IDs/URL, skip until data fixed
                        continue;
                    }
                    const key = await getShowtimesKeyFromTheatreUrl(r.theatre_url);
                    theaterKeyCache.set(r.theater_id, { key, locationId: r.location_id, fetchedAt: Date.now() });
                }
            }
            const { offsetSec, windowAfterSec } = PROVIDER_TIMING[provider] || DEFAULT_TIMING;

            // queue time = start_at + provider offset
            const startMs  = new Date(r.start_at).getTime();
            const trigger  = startMs + offsetSec * 1000;
            const windowEnd = trigger + windowAfterSec * 1000;


            // only enqueue if the window hasn’t completely expired yet
            if (Date.now() <= windowEnd) {
                const { local_date, local_time } = fmtLocalDateTime(r.start_at);
                const payload = {
                    provider,
                    showing_id: r.showing_id,
                    movie_id:   r.movie_id,
                    theater_id: r.theater_id,
                    movieTitle: r.movie_title,
                    local_date,
                    local_time,
                };
                if (provider === "cineplex") {
                    const got = theaterKeyCache.get(r.theater_id);
                    if (!got) continue;
                    payload.locationId  = got.locationId;
                    payload.showtimesKey = got.key;
                }
                heap.push({ ts: trigger, windowEnd, params: payload });
                enq++;
            }
        }
        console.log(`[sync] queued ${enq}/${q.rowCount} shows; heap=${heap.a.length}`);
    } finally {
        await client.end();
    }
}

/* ---------- Tick: scrape due (no DB) ---------- */
async function tick() {
    const now = Date.now();
    const due = [];
    while (heap.peek() && heap.peek().ts <= now) {
        const task = heap.pop();
        if (now <= task.windowEnd) due.push(task.params);
    }
    if (!due.length) return;

    await Promise.allSettled(
        due.map(p => scrapeLimit(async () => {
            try {
                let rec;
                if (p.provider === "cinematheque") {
                    rec = await cinemathequeScrapeSeats({
                        dateISO: p.local_date,
                        hhmm:    p.local_time,
                        title:   p.movieTitle,
                        });
                } else {
                    rec = await scrapeSeatsOnlyCineplex({
                        movieTitle: p.movieTitle,
                        local_date: p.local_date,
                        local_time: p.local_time,
                        locationId: p.locationId,
                        showtimesKey: p.showtimesKey
                    });
                }
                if (rec) {
                    measurements.push({
                        showing_id: p.showing_id,
                        movie_id:   p.movie_id,
                        theater_id: p.theater_id,
                        auditorium: rec.auditorium ?? null,
                        measured_at: rec.measured_at,
                        seats_remaining: rec.seats_remaining ?? null,
                        source: p.provider
                    });
                }
            } catch (e) {
                failures.push({ params: p, err: e?.message || String(e) });
                console.warn("[sample] failed:", e?.message || e, "payload:", p);
            }
        }))
    );

    console.log(`[tick] sampled ${due.length} show(s); buffered=${measurements.length}`);
}

/* ---------- Flush: batch upserts using measurement (single tx) ---------- */
async function flush(force=false) {
    if (!force && measurements.length < FLUSH_BATCH) return;
    const batch = measurements.splice(0, measurements.length);
    if (!batch.length) return;

    const client = getClient();
    await client.connect();
    try {
        await client.query("begin");
        let wrote = 0, skipped = 0;

        await Promise.allSettled(batch.map(m => upsertLimit(async () => {
            try {
                if (m.seats_remaining == null || m.auditorium == null) {
                    skipped++;
                    if (LOG_LEVEL === "debug") console.warn("[flush] skip (missing seats/aud)", m);
                    return;
                }
                const res = await upsertSeatsSoldFromMeasurement({ pgClient: client, measurement: m });
                wrote++;
                if (LOG_LEVEL === "debug") console.log("[flush] wrote", { showing_id: m.showing_id, seats_sold: res.seats_sold, screen_id: res.screen_id });
            } catch (e) {
                skipped++;
                console.warn("[flush] fail showing_id=", m.showing_id, e?.message || e);
            }
        })));

        await client.query("commit");
        console.log(`[flush] wrote ${wrote}, skipped ${skipped}`);
    } catch (e) {
        try { await client.query("rollback"); } catch {}
        console.error("[flush] transaction failed:", e?.message || e);
    } finally {
        await client.end();
    }
}

/* ---------- Scheduling ---------- */
async function main() {
    if (!inQuietHours()) await syncFromDb();

    // RESYNC every 3h
    setInterval(() => { if (!inQuietHours()) syncFromDb().catch(e => console.error("[sync] error", e)); }, RESYNC_MIN * 60 * 1000);

    // TICK every minute (scrape only)
    setInterval(() => { if (!inQuietHours()) tick().catch(e => console.error("[tick] error", e)); }, 60 * 1000);

    // FLUSH every 60 min
    setInterval(() => { if (!inQuietHours()) flush(false).catch(e => console.error("[flush] error", e)); }, FLUSH_MIN * 60 * 1000);

    // graceful shutdown → final flush
    const shutdown = async () => { try { await flush(true); } finally { process.exit(0); } };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log(`[start] seats heap daemon: resync=${RESYNC_MIN}m, lookahead=${LOOKAHEAD_H}h, tick=1m, flush=${FLUSH_MIN}m, batch=${FLUSH_BATCH}`);
}
main();
