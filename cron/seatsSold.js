import dotenv from "dotenv";
dotenv.config();

import { setGlobalDispatcher, Agent } from "undici";
import { neon } from "@neondatabase/serverless";         // HTTP driver for READS
import { getClient } from "../db/client.js";             // your pg TCP client (WRITES)
import { upsertSeatsSold, getShowtimesKeyFromTheatreUrl } from "../insert/insertAuditorium_cineplex.js";

/* ---------------- HTTP keep-alive for external fetches ---------------- */
setGlobalDispatcher(new Agent({
    connections: Number(process.env.HTTP_CONN || 16),
    pipelining: 1,
    keepAliveTimeout: 30_000,
}));

/* ---------------- Tiny priority queue (min-heap) ---------------- */
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

/* ---------------- Config ---------------- */
const TZ = "America/Toronto";
const CHECK_DELAY_SEC = Number(process.env.CHECK_DELAY_SEC || 13*60); // start+13m
const WINDOW_SEC      = Number(process.env.WINDOW_SEC      || 60);    // 60s
const RESYNC_MIN      = Number(process.env.RESYNC_MIN      || 180);   // 3h
const LOOKAHEAD_H     = Number(process.env.LOOKAHEAD_H     || 8);
const BACKPAD_MIN     = Number(process.env.BACKPAD_MIN     || 10);
const FLUSH_MIN       = Number(process.env.FLUSH_MIN       || 10);
const FLUSH_BATCH     = Number(process.env.FLUSH_BATCH     || 20);
const COMPANY_FILTER  = process.env.COMPANY_FILTER || "";  // e.g. "cine entreprise"
// ---- add near the top with other config
const QUIET_START = "01:00"; // inclusive
const QUIET_END   = "10:00"; // exclusive

function inQuietHours(now = new Date()) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false
    });
    const [{value:HH},, {value:mm}] = fmt.formatToParts(now);
    const cur = `${HH}:${mm}`;
    return (cur >= QUIET_START && cur < QUIET_END);
}


// Tag Neon query history
const sqlRead = neon(`${process.env.DATABASE_URL}?application_name=daemon-seats-read`);

/* ---------------- In-memory state ---------------- */
const heap   = new MinHeap();     // tasks with trigger time
const outbox = [];                // params for your existing upsertSeatsSold
const theaterKeyCache = new Map();// theater_id -> { key, locationId, fetchedAt }

/* ---------------- Helpers ---------------- */
function fmtLocalDateTime(iso) {
    const d  = new Date(iso);
    const df = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
    const tf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour:"2-digit", minute:"2-digit", hour12:false });
    const [{value:Y},, {value:M},, {value:D}] = df.formatToParts(d);
    const [{value:HH},, {value:mm}]           = tf.formatToParts(d);
    return { local_date: `${Y}-${M}-${D}`, local_time: `${HH}:${mm}` };
}

/* ---------------- One READ every few hours ---------------- */
async function syncFromDb() {
    const rows = await sqlRead/*sql*/`
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
          and s.start_at between (now() at time zone ${TZ} - make_interval(mins => ${BACKPAD_MIN}))
            and (now() at time zone ${TZ} + make_interval(hours => ${LOOKAHEAD_H}))
            ${COMPANY_FILTER ? sqlRead`and t.company = ${COMPANY_FILTER}` : sqlRead``}
        order by s.start_at;
    `;


    // Precompute showtimes keys per theater (cache for 1h)
    const now = Date.now();
    const perTheater = new Map();
    for (const r of rows) {
        if (!perTheater.has(r.theater_id)) {
            const cached = theaterKeyCache.get(r.theater_id);
            if (cached && (now - cached.fetchedAt) < 60*60*1000) {
                perTheater.set(r.theater_id, cached);
            } else {
                const key = await getShowtimesKeyFromTheatreUrl(r.theatre_url);
                const val = { key, locationId: r.location_id, fetchedAt: Date.now() };
                theaterKeyCache.set(r.theater_id, val);
                perTheater.set(r.theater_id, val);
            }
        }
    }

    // Enqueue each showing at start_at + 13m
    let enq = 0;
    for (const r of rows) {
        const { key, locationId } = perTheater.get(r.theater_id);
        const startMs = new Date(r.start_at).getTime();
        const trigger = startMs + CHECK_DELAY_SEC*1000;
        if (trigger >= now - 60*1000) {
            const { local_date, local_time } = fmtLocalDateTime(r.start_at);
            heap.push({
                ts: trigger,
                windowEnd: trigger + WINDOW_SEC*1000,
                params: {
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
    console.log(`[sync] queued ${enq}/${rows.length} shows; heap=${heap.a.length}`);
}

/* ---------------- Minute tick: work from memory; buffer params ---------------- */
async function tick() {
    const now = Date.now();
    let taken = 0;
    while (heap.peek() && heap.peek().ts <= now) {
        const task = heap.pop();
        if (now <= task.windowEnd) {
            outbox.push(task.params);   // keep your original upsert payload
            taken++;
        }
    }
    if (taken) console.log(`[tick] queued ${taken} due show(s) for flush`);
}

/* ---------------- Batched WRITE using your existing upsertSeatsSold ---------------- */
async function flush(force=false) {
    if (!force && outbox.length < FLUSH_BATCH) return;
    const batch = outbox.splice(0, outbox.length);
    if (!batch.length) return;

    const client = getClient();
    await client.connect();
    try {
        await client.query("begin");
        // Run sequentially (or small concurrency) with the SAME client
        for (const p of batch) {
            try {
                await upsertSeatsSold({ pgClient: client, ...p });
            } catch (e) {
                console.error("[flush] upsertSeatsSold failed:", e.message, "payload:", p);
            }
        }
        await client.query("commit");
        console.log(`[flush] wrote ${batch.length} item(s) via upsertSeatsSold`);
    } catch (e) {
        try { await client.query("rollback"); } catch {}
        throw e;
    } finally {
        await client.end();
    }
}

/* ---------------- Scheduling ---------------- */
async function main() {
    await (inQuietHours() ? Promise.resolve() : syncFromDb());
    setInterval(() => { if (!inQuietHours()) syncFromDb(); }, RESYNC_MIN * 60 * 1000);
    setInterval(() => { if (!inQuietHours()) tick(); }, 60 * 1000);
    setInterval(() => { if (!inQuietHours()) flush(false); }, FLUSH_MIN * 60 * 1000);

    // graceful shutdown
    const shutdown = async () => { try { await flush(true); } finally { process.exit(0); } };
    process.on("SIGINT",  shutdown);
    process.on("SIGTERM", shutdown);

    console.log(`[start] seats daemon: resync=${RESYNC_MIN}m, lookahead=${LOOKAHEAD_H}h, flush=${FLUSH_MIN}m`);
}
main();
