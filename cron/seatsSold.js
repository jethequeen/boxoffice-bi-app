// daemon/seats_heap_daemon.js  —  DROP-IN WITH PER-SHOWING AUDIT TRAIL
import { setGlobalDispatcher, Agent } from "undici";
import fs from "fs";
import { getClient } from "../db/client.js";
import { getShowtimesKeyFromTheatreUrl, upsertSeatsSoldFromMeasurement } from "../insert/insertAuditorium_cineplex.js";
import { getSeatsByTheater, classifyTheaterName } from "../scraper/provider_registry.js";

/* ---------- Hardcoded config (no envs) ---------- */
const TZ               = "America/Toronto";
const RESYNC_MIN       = 180;
const LOOKAHEAD_H      = 8;
const BACKPAD_MIN      = 15;
const FLUSH_MIN        = 60;
const FLUSH_BATCH      = 100;
const SCRAPE_CONC      = 6;
const UPSERT_CONC      = 8;
const KEY_CACHE_TTL_MS = 60*60*1000;
const QUIET_START      = "01:00"; // inclusive
const QUIET_END        = "10:00"; // exclusive
const LOG_LEVEL        = "debug";

/** Provider-specific timing (seconds) */
const PROVIDER_TIMING = {
    cinematheque:  { offsetSec: -7 * 60, windowAfterSec: 2 * 60 },
    cineplex:      { offsetSec: 12 * 60, windowAfterSec: 3 * 60 },
    webdev:        { offsetSec:  8 * 60, windowAfterSec: 3 * 60 },
    cineentreprise:{ offsetSec: -7 * 60, windowAfterSec: 1 },
};
const DEFAULT_TIMING = { offsetSec: 12 * 60, windowAfterSec: 5 * 60 };

/* ---------- AUDIT CONFIG ---------- */
const AUDIT_INCLUDE_CINEPLEX = false;                 // set true if you also want Cineplex traces
const AUDIT_FILE = process.env.AUDIT_FILE || "";      // e.g. "seats_audit.jsonl"
const auditEnabled = true;

/* ---------- HTTP keep-alive ---------- */
setGlobalDispatcher(new Agent({ connections: 16, pipelining: 1, keepAliveTimeout: 30_000 }));

/* ---------- p-limit ---------- */
function pLimit(n){ let a=0,q=[]; const run=async(fn,res,rej)=>{a++;try{res(await fn())}catch(e){rej(e)}finally{a--; if(q.length){const [f,r,j]=q.shift();run(f,r,j)}}}; return fn=>new Promise((res,rej)=>{a<n?run(fn,res,rej):q.push([fn,res,rej])});}
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

/* ---------- Per-showing audit ---------- */
const audits = new Map(); // showing_id -> audit object

function shouldAudit(provider){
    return auditEnabled && (AUDIT_INCLUDE_CINEPLEX || provider !== "cineplex");
}

function ensureAudit(id){
    let a = audits.get(id);
    if (!a) { a = {}; audits.set(id, a); }
    return a;
}

function auditPatch(id, patch){
    const a = ensureAudit(id);
    Object.assign(a, patch);
    if (shouldAudit(a.provider)) {
        // concise console line
        const line = [
            `[audit]`,
            `prov=${a.provider}`,
            a.theater_name ? `theater=${a.theater_name}` : null,
            a.movie_title ? `movie=${a.movie_title}` : null,
            a.local_date && a.local_time ? `at=${a.local_date} ${a.local_time}` : null,
            a.phase ? `phase=${a.phase}` : null,
            a.detail ? `detail=${a.detail}` : null,
            (a.seats_remaining!=null) ? `remain=${a.seats_remaining}` : null,
            (a.capacity!=null) ? `cap=${a.capacity}` : null,
            (a.seats_sold!=null) ? `sold=${a.seats_sold}` : null,
            a.reason ? `reason=${a.reason}` : null
        ].filter(Boolean).join(" ");
        console.log(line);
    }
    if (AUDIT_FILE && shouldAudit(a.provider)) {
        try {
            fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), showing_id: id, ...a }) + "\n");
        } catch {}
    }
}

/* ---------- Upsert helper for CE (unchanged logic) ---------- */
async function upsertBySeatCount({ pgClient, theater_id, showing_id, capacity, seats_remaining, measured_at, source }) {
    if (capacity == null || seats_remaining == null) return { wrote: false, reason: "missing capacity/seats_remaining" };

    const { rows } = await pgClient.query(
        `SELECT id AS screen_id, name, seat_count
         FROM screens
         WHERE theater_id = $1 AND seat_count = $2
         ORDER BY name
             LIMIT 1`,
        [theater_id, capacity]
    );
    if (!rows.length) return { wrote: false, reason: "no screen with that seat_count" };

    const screen_id = rows[0].screen_id;
    const seats_sold = Math.max(0, rows[0].seat_count - seats_remaining);

    await pgClient.query(
        `UPDATE showings
         SET screen_id = $2,
             seats_sold = $3,
             seats_sold_measured_at = $4,
             seats_sold_source = $5
         WHERE id = $1`,
        [showing_id, screen_id, seats_sold, measured_at, source || 'cineentreprise']
    );

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
                t.name                        AS theater_name
            FROM showings s
                     JOIN theaters t ON t.id = s.theater_id
                     JOIN movies   m ON m.id = s.movie_id
            WHERE s.seats_sold IS NULL
              AND s.start_at BETWEEN (now() - make_interval(mins => $1))
                AND (now() + make_interval(hours => $2))
            ORDER BY s.start_at
        `, [BACKPAD_MIN, LOOKAHEAD_H]);

        const nowMs = Date.now();
        let enq = 0;

        for (const r of q.rows) {
            const name = r.theater_name || "";
            const provider = classifyTheaterName(name) || "webdev";

            // Cineplex key prefetch
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

            const { local_date, local_time } = fmtLocalDateTime(r.start_at);
            const payload = {
                provider,
                showing_id:  r.showing_id,
                movie_id:    r.movie_id,
                theater_id:  r.theater_id,
                theater_name: name,
                movieTitle:  r.movie_title,
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

            // AUDIT: enqueued
            if (shouldAudit(provider)) {
                auditPatch(r.showing_id, {
                    phase: "ENQUEUED",
                    provider,
                    theater_name: name,
                    movie_title: r.movie_title,
                    local_date, local_time,
                    trigger_at: new Date(trigger).toISOString(),
                    window_end: new Date(windowEnd).toISOString(),
                });
            }
        }

        console.log(`[sync] queued ${enq}/${q.rowCount} shows; heap=${heap.a.length}`);
    } finally {
        await client.end();
    }
}

async function tick() {
    const now = Date.now();
    const due = [];
    while (heap.peek() && heap.peek().ts <= now) {
        const task = heap.pop();
        if (now <= task.windowEnd) {
            due.push(task.params);
        } else {
            // AUDIT: missed window at tick time
            const p = task.params;
            if (shouldAudit(p.provider)) {
                auditPatch(p.showing_id, { phase: "MISSED_WINDOW", detail: `now>${new Date(task.windowEnd).toISOString()}` });
            }
        }
    }
    if (!due.length) {
        if (LOG_LEVEL === "debug") {
            console.log(`[tick] heartbeat: heap=${heap.a.length} failures=${failures.length} queuedMeasurements=${measurements.length}`);
        }
        return;
    }

    // Priority — CE first, then Cineplex, then the rest
    const prio = { cineentreprise: 0, cineplex: 1, cinematheque: 2, webdev: 3 };
    due.sort((a, b) => (prio[a.provider] ?? 99) - (prio[b.provider] ?? 99));

    await Promise.allSettled(
        due.map(p => scrapeLimit(async () => {
            const should = shouldAudit(p.provider);
            try {
                if (should) auditPatch(p.showing_id, { phase: "SCRAPE_START" });
                const rec = await getSeatsByTheater(
                    p.theater_name,
                    { dateISO: p.local_date, hhmm: p.local_time, title: p.movieTitle },
                    p.provider === "cineplex"
                        ? { locationId: p.locationId, showtimesKey: p.showtimesKey, movieTitle: p.movieTitle }
                        : undefined
                );

                if (rec) {
                    const meas = {
                        showing_id:      p.showing_id,
                        movie_id:        p.movie_id,
                        theater_id:      p.theater_id,
                        auditorium:      rec.auditorium ?? null,
                        measured_at:     rec.measured_at,
                        seats_remaining: rec.seats_remaining ?? null,
                        source:          rec.source ?? p.provider,
                        capacity:        rec.sellable ?? rec.raw?.sellable ?? null,
                    };
                    measurements.push(meas);

                    if (should) {
                        auditPatch(p.showing_id, {
                            phase: "SCRAPE_OK",
                            seats_remaining: meas.seats_remaining ?? null,
                            capacity: meas.capacity ?? null,
                            detail: meas.auditorium ? `aud=${meas.auditorium}` : "no-auditorium",
                        });
                        auditPatch(p.showing_id, { phase: "BUFFERED" });
                    }
                } else {
                    if (should) auditPatch(p.showing_id, { phase: "SCRAPE_EMPTY", detail: "rec=null" });
                }
            } catch (e) {
                failures.push({ params: p, err: e?.message || String(e) });
                console.warn("[sample] failed:", e?.message || e, "payload:", p);
                if (should) auditPatch(p.showing_id, { phase: "SCRAPE_FAIL", detail: e?.message || String(e) });
            }
        }))
    );

    console.log(`[tick] sampled ${due.length} show(s); buffered=${measurements.length}`);
}

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
            const should = shouldAudit(m.source);
            try {
                if (m.source === "cineentreprise") {
                    const res = await upsertBySeatCount({
                        pgClient: client,
                        theater_id:      m.theater_id,
                        showing_id:      m.showing_id,
                        capacity:        m.capacity,
                        seats_remaining: m.seats_remaining,
                        measured_at:     m.measured_at,
                        source:          m.source,
                    });
                    if (res.wrote) {
                        wrote++;
                        if (should) auditPatch(m.showing_id, { phase: "FLUSH_WROTE", seats_sold: res.seats_sold, detail: `screen_id=${res.screen_id}` });
                        return;
                    }
                    skipped++;
                    if (LOG_LEVEL === "debug") console.warn("[flush/CE] skip:", res.reason, m);
                    if (should) auditPatch(m.showing_id, { phase: "FLUSH_SKIP", reason: res.reason });
                    return;
                }

                // existing path (expects auditorium + seats_remaining)
                if (m.seats_remaining == null || m.auditorium == null) {
                    skipped++;
                    if (LOG_LEVEL === "debug") console.warn("[flush] skip (missing seats/aud)", m);
                    if (should) auditPatch(m.showing_id, { phase: "FLUSH_SKIP", reason: "missing seats/auditorium" });
                    return;
                }
                const res = await upsertSeatsSoldFromMeasurement({ pgClient: client, measurement: m });
                wrote++;
                if (LOG_LEVEL === "debug") {
                    console.log("[flush] wrote", { showing_id: m.showing_id, seats_sold: res.seats_sold, screen_id: res.screen_id });
                }
                if (should) auditPatch(m.showing_id, { phase: "FLUSH_WROTE", seats_sold: res.seats_sold, detail: `screen_id=${res.screen_id}` });
            } catch (e) {
                skipped++;
                console.warn("[flush] fail showing_id=", m.showing_id, e?.message || e);
                if (should) auditPatch(m.showing_id, { phase: "FLUSH_FAIL", reason: e?.message || String(e) });
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

    setInterval(() => { if (!inQuietHours()) syncFromDb().catch(e => console.error("[sync] error", e)); }, RESYNC_MIN * 60 * 1000);
    setInterval(() => { if (!inQuietHours()) tick().catch(e => console.error("[tick] error", e)); }, 30 * 1000);
    setInterval(() => { if (!inQuietHours()) flush(false).catch(e => console.error("[flush] error", e)); }, FLUSH_MIN * 60 * 1000);

    const shutdown = async () => { try { await flush(true); } finally { process.exit(0); } };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log(`[start] seats heap daemon: resync=${RESYNC_MIN}m, lookahead=${LOOKAHEAD_H}h, tick=30 seconds, flush=${FLUSH_MIN}m, batch=${FLUSH_BATCH}`);
}
main();
