// cron/seatsSold.js
import dotenv from "dotenv";
dotenv.config();

import { setGlobalDispatcher, Agent } from "undici";
import { neon } from "@neondatabase/serverless";       // HTTP driver for READS
import { getClient } from "../db/client.js";           // pg TCP client (WRITES)
import {
    getShowtimesKeyFromTheatreUrl,
    scrapeSeatsOnly, // returns { measured_at, seats_remaining, capacity|null, auditorium|null }
} from "../insert/insertAuditorium_cineplex.js";

/* ---------------- HTTP keep-alive for external fetches ---------------- */
setGlobalDispatcher(new Agent({
    connections: Number(process.env.HTTP_CONN || 16),
    pipelining: 1,
    keepAliveTimeout: 30_000,
}));

/* ---------------- Tiny min-heap for due tasks ---------------- */
class MinHeap {
    constructor(){ this.a=[]; }
    push(x){ this.a.push(x); this._up(this.a.length-1); }
    peek(){ return this.a[0] || null; }
    pop(){ if(!this.a.length) return null; const t=this.a[0], l=this.a.pop();
        if(this.a.length){ this.a[0]=l; this._down(0); } return t; }
    _up(i){ for(;i>0;){ const p=(i-1>>1); if(this.a[p].ts<=this.a[i].ts) break;
        [this.a[p],this.a[i]]=[this.a[i],this.a[p]]; i=p; } }
    _down(i){ for(;;){ const l=i*2+1, r=l+1; let s=i;
        if(l<this.a.length && this.a[l].ts<this.a[s].ts) s=l;
        if(r<this.a.length && this.a[r].ts<this.a[s].ts) s=r;
        if(s===i) break; [this.a[s],this.a[i]]=[this.a[i],this.a[s]]; i=s; } }
}

/* ---------------- Simple p-limit for scraping concurrency ---------------- */
function pLimit(n) {
    let active = 0, queue = [];
    const run = async (fn, resolve, reject) => {
        active++;
        try { resolve(await fn()); } catch (e) { reject(e); }
        finally { active--; if (queue.length) { const [f,r,j]=queue.shift(); run(f,r,j); } }
    };
    return (fn) => new Promise((resolve, reject) => {
        if (active < n) run(fn, resolve, reject);
        else queue.push([fn, resolve, reject]);
    });
}
const SCRAPE_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 6);
const scrapeLimit = pLimit(SCRAPE_CONCURRENCY);

/* ---------------- Config ---------------- */
const TZ = "America/Toronto";
const CHECK_DELAY_SEC = Number(process.env.CHECK_DELAY_SEC || 13*60); // measure at start+X sec
const WINDOW_SEC      = Number(process.env.WINDOW_SEC      || 180);   // accept within this window
const RESYNC_MIN      = Number(process.env.RESYNC_MIN      || 180);
const LOOKAHEAD_H     = Number(process.env.LOOKAHEAD_H     || 8);
const BACKPAD_MIN     = Number(process.env.BACKPAD_MIN     || 15);
const FLUSH_MIN       = Number(process.env.FLUSH_MIN       || 60);
const FLUSH_BATCH     = Number(process.env.FLUSH_BATCH     || 100);
const COMPANY_FILTER  = process.env.COMPANY_FILTER || "";  // e.g. "cineplex"
const QUIET_START     = process.env.QUIET_START || "01:00"; // inclusive
const QUIET_END       = process.env.QUIET_END   || "10:00"; // exclusive

/* ---------------- Helpers ---------------- */
function inQuietHours(now = new Date()) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false
    });
    const [{value:HH},, {value:mm}] = fmt.formatToParts(now);
    const cur = `${HH}:${mm}`;
    return (cur >= QUIET_START && cur < QUIET_END);
}

function fmtLocalDateTime(iso) {
    const d  = new Date(iso);
    const df = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
    const tf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour:"2-digit", minute:"2-digit", hour12:false });
    const [{value:Y},, {value:M},, {value:D}] = df.formatToParts(d);
    const [{value:HH},, {value:mm}]           = tf.formatToParts(d);
    return { local_date: `${Y}-${M}-${D}`, local_time: `${HH}:${mm}` };
}

// Tag Neon query history
const sqlRead = neon(`${process.env.DATABASE_URL}?application_name=daemon-seats-read`);

/* ---------------- In-memory state ---------------- */
const heap         = new MinHeap(); // due tasks
const measurements = [];            // buffered measurements (for DB flush)
const failures     = [];            // diagnostics (optional)
const theaterKeyCache = new Map();  // theater_id -> { key, locationId, fetchedAt }

/* ---------------- Build queue from DB (READ ONLY) ---------------- */
async function syncFromDb() {
    const base = await sqlRead/*sql*/`
    select
      s.id                          as showing_id,
      s.movie_id,
      s.theater_id,
      coalesce(m.fr_title, m.title) as movie_title,
      s.start_at,
      t.theater_api_id              as location_id,
      t.showings_url                as theatre_url,
      t.company
    from showings s
      join theaters t on t.id = s.theater_id
      join movies   m on m.id = s.movie_id
    where t.theater_api_id is not null
      and s.seats_sold is null
      and s.start_at between (now() - make_interval(mins => ${BACKPAD_MIN}))
                         and (now() + make_interval(hours => ${LOOKAHEAD_H}))
    ${COMPANY_FILTER ? sqlRead`and t.company = ${COMPANY_FILTER}` : sqlRead``}
    order by s.start_at;
  `;

    // Precompute showtimes keys per theater (cache 60m)
    const nowMs = Date.now();
    const perTheater = new Map();
    for (const r of base) {
        if (!perTheater.has(r.theater_id)) {
            const cached = theaterKeyCache.get(r.theater_id);
            if (cached && (nowMs - cached.fetchedAt) < 60*60*1000) {
                perTheater.set(r.theater_id, cached);
            } else {
                const key = await getShowtimesKeyFromTheatreUrl(r.theatre_url);
                const val = { key, locationId: r.location_id, fetchedAt: Date.now() };
                theaterKeyCache.set(r.theater_id, val);
                perTheater.set(r.theater_id, val);
            }
        }
    }

    // Enqueue each showing at start_at + CHECK_DELAY_SEC
    let enq = 0;
    for (const r of base) {
        const got = perTheater.get(r.theater_id);
        if (!got) continue;
        const { key, locationId } = got;

        const startMs = new Date(r.start_at).getTime();
        const trigger = startMs + CHECK_DELAY_SEC * 1000;
        if (trigger >= nowMs - 60*1000) {
            const { local_date, local_time } = fmtLocalDateTime(r.start_at);
            heap.push({
                ts: trigger,
                windowEnd: trigger + WINDOW_SEC * 1000,
                params: {
                    showing_id: r.showing_id,
                    movie_id:   r.movie_id,
                    theater_id: r.theater_id,
                    movieTitle: r.movie_title,
                    local_date,
                    local_time,
                    locationId,
                    showtimesKey: key,
                }
            });
            enq++;
        }
    }
    console.log(`[sync] queued ${enq}/${base.length} shows; heap=${heap.a.length}`);
}

/* ---------------- Scrape seats (HTTP only; no DB) ---------------- */
async function measureOne(params) {
    const m = await scrapeSeatsOnly({
        movieTitle:   params.movieTitle,
        local_date:   params.local_date,
        local_time:   params.local_time,
        locationId:   params.locationId,
        showtimesKey: params.showtimesKey,
    });
    if (!m) return null;
    return {
        showing_id: params.showing_id,
        theater_id: params.theater_id,
        auditorium: m.auditorium ?? null,
        measured_at: m.measured_at || new Date().toISOString(),
        seats_remaining: m.seats_remaining ?? null,
        capacity: m.capacity ?? null, // may be null; we’ll hydrate in flush
        source: "cineplex",
    };
}

/* ---------------- Minute tick: pop due tasks, scrape now ---------------- */
async function tick() {
    const now = Date.now();
    const due = [];
    while (heap.peek() && heap.peek().ts <= now) {
        const task = heap.pop();
        if (now <= task.windowEnd) due.push(task);
    }
    if (!due.length) return;

    const jobs = due.map(task =>
        scrapeLimit(async () => {
            try {
                const rec = await measureOne(task.params);
                if (rec) measurements.push(rec);
            } catch (e) {
                failures.push({ params: task.params, err: e?.message || String(e) });
                console.warn("[sample] failed:", e?.message || e, "payload:", task.params);
            }
        })
    );

    await Promise.allSettled(jobs);
    console.log(`[tick] sampled ${due.length} show(s); buffered=${measurements.length}`);
}

/* ---------------- Batched WRITE: direct -> showings.seats_sold ---------------- */
async function flush(force=false) {
    if (!force && measurements.length < FLUSH_BATCH) return;
    const batch = measurements.splice(0, measurements.length);
    if (!batch.length) return;

    const client = getClient();
    await client.connect();
    try {
        // 0) Preload showings metadata (screen_id, theater_id, current seat_count if any)
        const ids = batch.map(b => Number(b.showing_id)).filter(Number.isFinite);
        const metaRes = await client.query(
            `select s.id, s.theater_id, s.screen_id, sc.seat_count, sc.name as screen_name
         from showings s
         left join screens sc on sc.id = s.screen_id
        where s.id = any($1::int[])`,
            [ids]
        );
        const metaMap = new Map(metaRes.rows.map(r => [r.id, r]));

        await client.query("begin");

        let wrote = 0, skipped = 0;
        for (const m of batch) {
            const meta = metaMap.get(Number(m.showing_id));
            if (!meta) { skipped++; continue; }

            let screenId = meta.screen_id;
            let capacity = meta.seat_count ?? null;

            // If we don’t know capacity yet, try to resolve a screen by auditorium name
            if ((capacity == null || screenId == null) && m.auditorium && m.theater_id) {
                const guess = await client.query(
                    `select id, seat_count
             from screens
            where theater_id = $1 and (name = $2 or name ilike $3)
            order by (name = $2) desc, length(name)
            limit 1`,
                    [m.theater_id, m.auditorium, `%${m.auditorium}%`]
                );
                if (guess.rowCount) {
                    screenId = screenId ?? guess.rows[0].id;
                    capacity = capacity ?? guess.rows[0].seat_count ?? null;

                    // attach the screen if the showing didn’t have one yet
                    if (screenId && meta.screen_id == null) {
                        await client.query(`update showings set screen_id = $1 where id = $2`, [screenId, m.showing_id]);
                    }
                }
            }

            // If we still don’t know capacity or seats_remaining, can’t compute seats_sold
            if (capacity == null || m.seats_remaining == null) { skipped++; continue; }

            const seatsSold = Math.max(0, Number(capacity) - Number(m.seats_remaining));
            await client.query(
                `update showings
            set seats_sold = $1
          where id = $2
            and (seats_sold is distinct from $1)`,
                [seatsSold, m.showing_id]
            );
            wrote++;
        }

        await client.query("commit");
        console.log(`[flush] wrote ${wrote}, skipped ${skipped} (no capacity or no seats_remaining)`);
    } catch (e) {
        try { await client.query("rollback"); } catch {}
        console.error("[flush] transaction failed:", e?.message || e);
    } finally {
        await client.end();
    }
}

/* ---------------- Scheduling ---------------- */
async function main() {
    if (!inQuietHours()) await syncFromDb();

    // RESYNC: rebuild queue from DB (read-only)
    setInterval(() => { if (!inQuietHours()) syncFromDb(); }, RESYNC_MIN * 60 * 1000);

    // TICK: run every minute (scrape due shows; no DB)
    setInterval(() => { if (!inQuietHours()) tick(); }, 60 * 1000);

    // FLUSH: batch write to DB (short tx)
    setInterval(() => { if (!inQuietHours()) flush(false); }, FLUSH_MIN * 60 * 1000);

    // graceful shutdown
    const shutdown = async () => { try { await flush(true); } finally { process.exit(0); } };
    process.on("SIGINT",  shutdown);
    process.on("SIGTERM", shutdown);

    console.log(`[start] seats daemon: resync=${RESYNC_MIN}m, lookahead=${LOOKAHEAD_H}h, flush=${FLUSH_MIN}m`);
}
main();
