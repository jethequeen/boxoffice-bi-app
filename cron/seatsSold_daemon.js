// cron/seatsSold_daemon.js
import {Agent, setGlobalDispatcher} from "undici";
import {getClient} from "../db/client.js";
import {getShowtimesKeyFromTheatreUrl, upsertSeatsSoldFromMeasurement} from "../insert/insertAuditorium_cineplex.js";
import {classifyTheaterName, getSeatsByTheater} from "../scraper/provider_registry.js";
import {runNightPrefillWebdev} from "./billeterie_schedule.js";
import {exec} from "child_process";
import {getWebdevWindowForTheater} from "../scraper/webdev_providers.js";
import fs from "fs";

/* ---------- Hardcoded config (no envs) ---------- */
const TZ               = "America/Toronto";
const RESYNC_MIN       = 180;
const LOOKAHEAD_H      = 4;
const BACKPAD_MIN      = 15;
const FLUSH_MIN        = 60;
const FLUSH_BATCH      = 100;
const SCRAPE_CONC      = 6;
const UPSERT_CONC      = 8;
const KEY_CACHE_TTL_MS = 60*60*1000;
const QUIET_START      = "01:00"; // inclusive
const QUIET_END        = "09:30"; // exclusive
const LOG_LEVEL        = "info";

/* ---------- Tick cadence & window safety ---------- */
const TICK_MS = 15_000;
const MIN_SPAN_SEC = Math.max(60, Math.ceil(TICK_MS/1000) + 15); // ensure window >= ~45–60s

/* ---------- Provider windows: relative to show start (in seconds) ----------
   Eligibility: now in [start_at + windowStartSec, start_at + windowEndSec]
   Examples:
   - CE:  -7m ..  0m   (seven minutes before up to showtime)
   - CX: +12m .. +15m  (twelve minutes after up to fifteen after)
--------------------------------------------------------------------------- */
const PROVIDER_WINDOWS = {
    cineentreprise: { windowStartSec: -(7*60 + 15), windowEndSec: 0 },        // -7:15 .. 0:00
    cineplex:       { windowStartSec:  (12*60 + 30), windowEndSec: (15*60+30)},// +12:30 .. +15:30
    webdev:         { windowStartSec:  (13*60 + 45), windowEndSec: (16*60+45)},// +13:45 .. +16:45
    cinematheque:   { windowStartSec: -(7*60),       windowEndSec: -(60)    },// -7:00 .. -1:00
};

const DEFAULT_WINDOW = { windowStartSec: 12 * 60, windowEndSec: 17 * 60 };

function normalizeWindow(w) {
    const out = { ...w };
    if (out.windowEndSec < out.windowStartSec + MIN_SPAN_SEC) {
        out.windowEndSec = out.windowStartSec + MIN_SPAN_SEC;
    }
    return out;
}

const TMPDIR = process.env.TMPDIR || "/tmp/seats-sold";

async function ensureTmp() {
    try {
        await fs.promises.mkdir(TMPDIR, { recursive: true, mode: 0o1777 });
    } catch {}
}

/* ---------- HTTP keep-alive ---------- */
setGlobalDispatcher(new Agent({ connections: 16, pipelining: 1, keepAliveTimeout: 30_000 }));

/* ---------- p-limit ---------- */
function pLimit(n){ let a=0,q=[]; const run=async(fn,res,rej)=>{a++;try{res(await fn())}catch(e){rej(e)}finally{a--; if(q.length){const [f,r,j]=q.shift();run(f,r,j)}}}; return fn=>new Promise((res,rej)=>{a<n?run(fn,res,rej):q.push([fn,res,rej])});}
const scrapeLimit = pLimit(SCRAPE_CONC);
const upsertLimit = pLimit(UPSERT_CONC);

/* ---------- Min-heap ---------- */
class MinHeap{ constructor(){this.a=[]} push(x){this.a.push(x);this._up(this.a.length-1)} peek(){return this.a[0]||null} pop(){if(!this.a.length)return null;const t=this.a[0],l=this.a.pop();if(this.a.length){this.a[0]=l;this._down(0)}return t} _up(i){for(;i>0;){const p=(i-1>>1); if(this.a[p].ts<=this.a[i].ts) break; [this.a[p],this.a[i]]=[this.a[i],this.a[p]]; i=p;}} _down(i){for(;;){const l=i*2+1,r=l+1;let s=i; if(l<this.a.length && this.a[l].ts<this.a[s].ts) s=l; if(r<this.a.length && this.a[r].ts<this.a[s].ts) s=r; if(s===i) break; [this.a[s],this.a[i]]=[this.a[i],this.a[s]]; i=s;}} }

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

// ---- schema-aware CE upsert with fuzzy seat_count match (±tolerance) ----
const CE_SEAT_TOLERANCE = parseInt(process.env.CE_SEAT_TOLERANCE || "10", 10);

async function upsertBySeatCount({ pgClient, theater_id, showing_id, capacity, seats_remaining /* measured_at, source */ }) {
    if (capacity == null || seats_remaining == null) {
        return { wrote: false, reason: "missing capacity/seats_remaining" };
    }

    // 1) exact seat_count match
    let row;
    {
        const { rows } = await pgClient.query(
            `SELECT id AS screen_id, name, seat_count
             FROM screens
             WHERE theater_id = $1 AND seat_count = $2
             ORDER BY name
                 LIMIT 1`,
            [theater_id, capacity]
        );
        row = rows[0];
    }

    // 2) fuzzy match within ± tolerance (closest first)
    let fuzzy = false;
    if (!row && CE_SEAT_TOLERANCE > 0) {
        const { rows } = await pgClient.query(
            `SELECT id AS screen_id, name, seat_count,
                    ABS(seat_count - $2) AS delta
             FROM screens
             WHERE theater_id = $1
               AND seat_count BETWEEN ($2 - $3) AND ($2 + $3)
             ORDER BY delta ASC, seat_count DESC, name
                 LIMIT 1`,
            [theater_id, capacity, CE_SEAT_TOLERANCE]
        );
        if (rows.length) {
            row = rows[0];
            fuzzy = true;
        }
    }

    if (!row) return { wrote: false, reason: "no screen with that seat_count (even fuzzy)" };

    const screen_id = row.screen_id;
    const seats_sold_raw = (row.seat_count ?? 0) - (seats_remaining ?? 0);
    const seats_sold = Math.max(0, Math.min(row.seat_count ?? 0, seats_sold_raw));

// write seats_sold
    await pgClient.query(
        `UPDATE showings
         SET seats_sold = $1
         WHERE id = $2`,
        [seats_sold, showing_id]
    );

// set screen only if it's not already set (tolerant, write-once)
    await pgClient.query(
        `UPDATE showings
     SET screen_id = $1
   WHERE id = $2
     AND screen_id IS NULL`,
        [screen_id, showing_id]
    );

    if (fuzzy && (process.env.LOG_LEVEL || "debug") === "debug") {
        console.warn("[flush/CE] fuzzy seat_count match", {
            showing_id,
            theater_id,
            scraped_capacity: capacity,
            matched_screen_seat_count: row.seat_count,
            tolerance: CE_SEAT_TOLERANCE
        });
    }

    return { wrote: true, screen_id, seats_sold };
}


/* ---------- State ---------- */
const heap         = new MinHeap();
const measurements = [];
const failures     = [];
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
                s.purchase_url,
                t.name                        AS theater_name,
                s.screen_id,
                sc.seat_count                 AS screen_seat_count
            FROM showings s
                     JOIN theaters t ON t.id = s.theater_id
                     JOIN movies   m ON m.id = s.movie_id
                     LEFT JOIN screens sc ON sc.id = s.screen_id
            WHERE s.seats_sold IS NULL
              AND s.start_at BETWEEN (now() - make_interval(mins => $1))
                AND (now() + make_interval(hours => $2))
            ORDER BY s.start_at

        `, [BACKPAD_MIN, LOOKAHEAD_H]);

        const now = Date.now();
        let enq = 0;

        for (const r of q.rows) {
            const name = r.theater_name || "";
            const provider = classifyTheaterName(name);  // no default "webdev"
            if (!provider) {
                failures.push({ params: { showing_id: r.showing_id, theater_name: name }, err: "unmapped_theater" });
                continue;
            }

            // Cineplex: prefetch API key once per theater
            if (provider === "cineplex") {
                const cached = theaterKeyCache.get(r.theater_id);
                if (!cached || (now - cached.fetchedAt) > KEY_CACHE_TTL_MS) {
                    if (!r.theatre_url || !r.location_id) continue;
                    const key = await getShowtimesKeyFromTheatreUrl(r.theatre_url);
                    theaterKeyCache.set(r.theater_id, { key, locationId: r.location_id, fetchedAt: Date.now() });
                }
            }

            let base = PROVIDER_WINDOWS[provider] || DEFAULT_WINDOW;
            if (provider === "webdev") {
                const override = getWebdevWindowForTheater(name);
                if (override) base = override;
            }
            base = normalizeWindow(base);
            const startMs = new Date(r.start_at).getTime();
            const winStart = startMs + base.windowStartSec * 1000; // when we BEGIN scraping
            const winEnd   = startMs + base.windowEndSec   * 1000; // when we STOP scraping

            if (now <= winEnd) {
                const { local_date, local_time } = fmtLocalDateTime(r.start_at);
                const payload = {
                    provider,
                    showing_id: r.showing_id,
                    purchase_url: r.purchase_url,
                    movie_id:   r.movie_id,
                    theater_id: r.theater_id,
                    theater_name: name,
                    movieTitle: r.movie_title,
                    local_date,
                    local_time,
                    seat_count: r.screen_seat_count ?? null,
                };
                if (provider === "cineplex") {
                    const got = theaterKeyCache.get(r.theater_id);
                    if (!got) continue;
                    payload.locationId   = got.locationId;
                    payload.showtimesKey = got.key;
                }
                // schedule at window start (if window already started, we'll pick it up next tick)
                heap.push({ ts: winStart, windowEnd: winEnd, params: payload });
                enq++;
            }
        }

        console.log(`[sync] queued ${enq}/${q.rowCount} shows; heap=${heap.a.length}`);
    } finally {
        await client.end();
    }
}

/* ---------- TICK ---------- */
async function tick() {
    const now = Date.now();
    const due = [];
    while (heap.peek() && heap.peek().ts <= now) {
        const task = heap.pop();
        if (now <= task.windowEnd) {
            due.push(task.params);
        }
    }
    if (!due.length) return;

    const prio = { cineentreprise: 0, cineplex: 1, cinematheque: 2, webdev: 3 };
    due.sort((a, b) => (prio[a.provider] ?? 99) - (prio[b.provider] ?? 99));

    await Promise.allSettled(
        due.map(p => scrapeLimit(async () => {
            try {
                const rec = await getSeatsByTheater(
                    p.theater_name,
                    {
                        dateISO: p.local_date,
                        hhmm:    p.local_time,
                        title:   p.movieTitle,
                        showUrl: p.purchase_url,
                        ...(p.seat_count != null ? { expectedCapacity: p.seat_count } : {})
                    },
                    p.provider === "cineplex"
                        ? { locationId: p.locationId, showtimesKey: p.showtimesKey, movieTitle: p.movieTitle }
                        : undefined
                );

                if (rec) {
                    measurements.push({
                        showing_id:      p.showing_id,
                        movie_id:        p.movie_id,
                        theater_id:      p.theater_id,
                        auditorium:      rec.auditorium ?? null,
                        seats_remaining: rec.seats_remaining ?? null,
                        source:          rec.source ?? p.provider,
                        capacity:        rec.sellable ?? rec.raw?.sellable ?? null, // for CE seat_count mapping
                    });
                }
            } catch (e) {
                failures.push({ params: p, err: e?.message || String(e) });
            }
        }))
    );

    console.log(`[tick] sampled ${due.length} show(s); buffered=${measurements.length}`);
}

/* ---------- FLUSH ---------- */
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
                if (m.source === "cineentreprise") {
                    const res = await upsertBySeatCount({
                        pgClient: client,
                        theater_id:      m.theater_id,
                        showing_id:      m.showing_id,
                        capacity:        m.capacity,
                        seats_remaining: m.seats_remaining,
                        source:          m.source,
                    });
                    if (res.wrote) { wrote++; return; }
                    skipped++;
                    if (LOG_LEVEL === "debug") console.warn("[flush/CE] skip:", res.reason, m);
                    return;
                }

                if (m.seats_remaining == null) {
                    skipped++;
                    if (LOG_LEVEL === "debug") console.warn("[flush] skip (missing seats/aud)", m);
                    return;
                }
                const res = await upsertSeatsSoldFromMeasurement({ pgClient: client, measurement: m });
                wrote++;
                if (LOG_LEVEL === "debug") {
                    console.log("[flush] wrote", { showing_id: m.showing_id, seats_sold: res.seats_sold, screen_id: res.screen_id });
                }
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

async function cleanTmp() {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const cmd = [
        "find", TMPDIR, "-xdev", "-type", "f", "-mmin", "+90",
        ...(uid !== null ? ["-user", String(uid)] : []),
        "-writable",
        "!", "-name", "*.lock",
        "!", "-name", "*.pid",
        "-delete",
        "2>/dev/null" // supprime le bruit, au cas où
    ].join(" ");
    exec(cmd, err => { if (err) console.warn("[cleanup]", err.message); });
}




/* ---------- Scheduling ---------- */
async function main() {
    await ensureTmp();
    if (!inQuietHours()) await syncFromDb();

    setInterval(() => { if (!inQuietHours()) syncFromDb().catch(e => console.error("[sync] error", e)); }, RESYNC_MIN * 60 * 1000);
    setInterval(() => { if (!inQuietHours()) tick().catch(e => console.error("[tick] error", e)); }, TICK_MS);
    setInterval(() => { if (!inQuietHours()) flush(false).catch(e => console.error("[flush] error", e)); }, FLUSH_MIN * 60 * 1000);
    setInterval(tryNightPrefill, 6 * 60 * 60 * 1000);  // every 6 hours, only runs during quiet hours
    setInterval(cleanTmp, 30 * 60 * 1000);  // every 30 min

    async function tryNightPrefill(){
        if (inQuietHours()) {
            try {
                await runNightPrefillWebdev({
                    dryRun: false
                });
            } catch(e){
                console.warn("[prefill] error:", e?.message || e);
            }
        }
    }




    const shutdown = async () => { try { await flush(true); } finally { process.exit(0); } };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log(`[start] seats heap daemon: resync=${RESYNC_MIN}m, lookahead=${LOOKAHEAD_H}h, tick=${Math.round(TICK_MS/1000)} seconds, flush=${FLUSH_MIN}m, batch=${FLUSH_BATCH}`);
}
main();
