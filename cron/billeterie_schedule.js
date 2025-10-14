// cron/billeterie_schedule.js
import { getClient } from "../db/client.js";
import { getScheduleByName, findWebdevProviderByName } from "../scraper/webdev_providers.js";
import { classifyTheaterName } from "../scraper/provider_registry.js"; // getSeatsByTheater no longer used

const TZ = "America/Toronto";
const MAX_LOOKAHEAD_DAYS = parseInt(process.env.WEBDEV_PREFILL_LOOKAHEAD_DAYS || "14", 10);
const CE_SEAT_TOLERANCE  = parseInt(process.env.CE_SEAT_TOLERANCE || "10", 10);
const LOG_LEVEL = process.env.LOG_LEVEL || "debug";

/* ----------------------------- time helpers ----------------------------- */
function toISO(d){ return new Date(d).toISOString().slice(0,10); }
function addDays(dateISO, days){
    const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return toISO(d);
}
function fmtLocal(iso){
    const d=new Date(iso);
    const df=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
    const tf=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
    const [{value:Y},, {value:M},, {value:D}] = df.formatToParts(d);
    const [{value:HH},, {value:mm}] = tf.formatToParts(d);
    return { dateISO: `${Y}-${M}-${D}`, hhmm: `${HH}:${mm}` };
}

/* ------------------------- title-first normalizer ------------------------ */
function normalizeTitle(s = "") {
    return s.normalize("NFD").replace(/\p{Diacritic}/gu,"")
        .replace(/\b(VF|VOA?|VOST(?:FR)?|IMAX|ATMOS|4DX|D-?BOX|HFR|3D|2D|Dolby(?:\s+Cinema)?)\b/gi, " ")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/[’']/g, " ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/^(le|la|les|the|l|un|une)\s+/g, "")
        .trim();
}
function tokenSim(a,b){
    const A = new Set(normalizeTitle(a).split(" ").filter(Boolean));
    const B = new Set(normalizeTitle(b).split(" ").filter(Boolean));
    if (!A.size || !B.size) return 0;
    let inter=0; for (const x of A) if (B.has(x)) inter++;
    return inter / Math.max(A.size, B.size);
}
function lightNormTitle(s = "") {
    return String(s)
        .normalize("NFD").replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/* ------------------ permissive "LIKE" helpers (for matching) ------------------ */
const NOISE_RE = /\b(VF|VOA?|VOST(?:FR)?|IMAX|ATMOS|4DX|D-?BOX|HFR|3D|2D|Dolby(?:\s+Cinema)?)\b/gi;

function baseNormalize(s=""){
    return String(s)
        .normalize("NFD").replace(/\p{Diacritic}/gu,"")
        .replace(NOISE_RE, " ")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/[’']/g, " ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/^(le|la|les|the|l|un|une)\s+/g, "")
        .trim();
}

function normFlat(s=""){
    // remove spaces so truncated strings like "… : L" still match
    return baseNormalize(s).replace(/\s+/g, "");
}

function tokensLoose(s=""){
    return baseNormalize(s).split(" ").filter(Boolean);
}


/* ------------------------- version signature (VO/VF/3D/…) ------------------------ */
function extractVersionSig(rawTitle = "") {
    const hasVF   = /\bV\.?F\.?\b/i.test(rawTitle) || /\bVF\b/i.test(rawTitle);
    const hasVO   = /\bV\.?O\.?A?\.?\b/i.test(rawTitle) || /\bVOA?\b/i.test(rawTitle);
    const hasVOST = /\bVOST(?:FR|A)?\b/i.test(rawTitle);

    const flags = [];
    if (hasVF) flags.push("VF");
    if (hasVO) flags.push("VOA");
    if (hasVOST) flags.push("VOST");

    if (/\bIMAX\b/i.test(rawTitle))   flags.push("IMAX");
    if (/\bATMOS\b/i.test(rawTitle))  flags.push("ATMOS");
    if (/\b4DX\b/i.test(rawTitle))    flags.push("4DX");
    if (/\bD-?BOX\b/i.test(rawTitle)) flags.push("DBOX");
    if (/\bHFR\b/i.test(rawTitle))    flags.push("HFR");
    if (/\b3D\b/i.test(rawTitle))     flags.push("3D");
    if (/\b2D\b/i.test(rawTitle))     flags.push("2D");

    const sig = [...new Set(flags)].sort().join("+");
    return sig || "default";
}

/* -------- seat_count → screen_id (exact, then ceiling, then floor) -------- */
async function mapCapacityToScreenId(pg, theater_id, capacity) {
    // 1) exact
    let row = (await pg.query(
        `SELECT id AS screen_id
         FROM screens
         WHERE theater_id = $1 AND seat_count = $2
         ORDER BY name
             LIMIT 1`,
        [theater_id, capacity]
    )).rows[0];
    if (row) return row.screen_id;

    // 2) ceiling
    row = (await pg.query(
        `SELECT id AS screen_id, seat_count
         FROM screens
         WHERE theater_id = $1 AND seat_count >= $2
         ORDER BY seat_count ASC, name
             LIMIT 1`,
        [theater_id, capacity]
    )).rows[0];
    if (row) return row.screen_id;

    // 3) floor fallback
    row = (await pg.query(
        `SELECT id AS screen_id, seat_count
         FROM screens
         WHERE theater_id = $1 AND seat_count < $2
         ORDER BY seat_count DESC, name
             LIMIT 1`,
        [theater_id, capacity]
    )).rows[0];

    return row?.screen_id || null;
}

/* ---------- Pull all (webdev, notDisplayingSeats) showings lacking screen_id ---------- */
async function loadTargets(pg){
    const q = await pg.query(`
        SELECT s.id AS showing_id, s.movie_id, s.theater_id, s.start_at, s.screen_id,
               s.purchase_url,
               COALESCE(m.fr_title, m.title) AS movie_title,
               t.name AS theater_name
        FROM showings s
                 JOIN theaters t ON t.id = s.theater_id
                 JOIN movies   m ON m.id = s.movie_id
        WHERE s.screen_id IS NULL
          AND s.start_at >= now()
        ORDER BY t.name, m.title, s.start_at
    `);

    const filtered = [];
    for (const r of q.rows){
        if (classifyTheaterName(r.theater_name) !== "webdev") continue;
        const prov = findWebdevProviderByName(r.theater_name);
        if (!prov || prov.kind !== "notDisplayingSeats") continue;
        filtered.push(r);
    }
    return filtered;
}

/* -------- fetch full schedule rows for a day -------- */
async function daySchedule(theaterName, dateISO){
    return await getScheduleByName(theaterName, { dateISO, dump:false }) || [];
}

/* ---------- purchase_url picker (gentler) ---------- */
/* ---------- purchase_url picker (simple + truncation-tolerant) ---------- */
function pickUrlForShow(items, hhmm, movieTitle) {
    const list = (items || []).filter(it => it && it.url && it.time);
    if (!list.length) return { url: "", strategy: "no-items" };

    const atTime = list.filter(it => it.time === hhmm);
    if (!atTime.length) return { url: "", strategy: "no-time-match" };

    if (atTime.length === 1) return { url: atTime[0].url, strategy: "time-only-single" };

    const tgtFlat = normFlat(movieTitle);
    const tgtToks = tokensLoose(movieTitle);

    // 1) containment either way (LIKE)
    for (const it of atTime) {
        const candFlat = normFlat(it.title || "");
        if (!candFlat) continue;
        if (tgtFlat.includes(candFlat) || candFlat.includes(tgtFlat)) {
            return { url: it.url, strategy: "containment-like" };
        }
    }

    // 2) token overlap ≥ 2 (lower bar, robust to truncation/order)
    let best = null, bestInter = -1;
    for (const it of atTime) {
        const candToks = tokensLoose(it.title || "");
        let inter = 0;
        for (const t of candToks) if (tgtToks.includes(t)) inter++;
        if (inter > bestInter) { best = it; bestInter = inter; }
    }
    if (best && bestInter >= 2) return { url: best.url, strategy: `token-overlap(${bestInter})` };

    // 3) deterministic fallback to first candidate at that time
    return { url: atTime[0].url, strategy: "fallback-first" };
}


/* ---------- Fill purchase_url PER SHOWING (no movie grouping) ---------- */
async function fillPurchaseUrlsForShowings(pg, theaterName, rows, startISO, endISO, { dryRun = false } = {}){
    const versionByShowing = new Map();
    const scheduleCache = new Map();
    let updates = 0;

    const ensureSched = async (dateISO) => {
        if (!scheduleCache.has(dateISO)){
            const sched = await daySchedule(theaterName, dateISO);
            scheduleCache.set(dateISO, Array.isArray(sched) ? sched : []);
        }
        return scheduleCache.get(dateISO);
    };

    for (const r of rows){
        const { dateISO, hhmm } = fmtLocal(r.start_at);
        if (dateISO < startISO || dateISO > endISO) continue;
        if (r.purchase_url) continue;

        const sched = await ensureSched(dateISO);
        const picked = pickUrlForShow(sched, hhmm, r.movie_title);
        const url = picked.url;
        if (!url) continue;

        // DB-level uniqueness guard (make it time-aware so reused URLs across times are allowed)
        const dupe = await pg.query(
            `SELECT 1
         FROM showings
        WHERE theater_id = $1
          AND id <> $2
          AND purchase_url = $3
          AND ((start_at AT TIME ZONE $4)::time = $5::time)
        LIMIT 1`,
            [r.theater_id, r.showing_id, url, TZ, hhmm]
        );
        if (dupe.rowCount > 0) continue;

        const item = (sched || []).find(it => it.url === url && it.time === hhmm);
        const versionSig = extractVersionSig(item?.title || "");

        if (dryRun) {
            if (LOG_LEVEL !== "silent") {
                console.log("[prefill/dryrun] purchase_url", {
                    theaterName, dateISO, hhmm, showing_id: r.showing_id, strategy: picked.strategy, url, versionSig
                });
            }
            r.purchase_url = url;
            versionByShowing.set(r.showing_id, versionSig);
            updates++;
        } else {
            const res = await pg.query(
                `UPDATE showings
            SET purchase_url = $1
          WHERE id = $2
            AND purchase_url IS NULL`,
                [url, r.showing_id]
            );
            if (res.rowCount > 0) {
                r.purchase_url = r.purchase_url || url;
                versionByShowing.set(r.showing_id, versionSig);
                updates += res.rowCount;
            }
        }
    }

    return { updates, versionByShowing };
}

/* ---------- DB: distinct seat counts for a theater ---------- */
async function getKnownSeatCounts(pg, theater_id) {
    const { rows } = await pg.query(
        `SELECT DISTINCT seat_count
         FROM screens
         WHERE theater_id = $1
           AND seat_count IS NOT NULL
         ORDER BY seat_count DESC`,
        [theater_id]
    );
    return rows.map(r => Number(r.seat_count)).filter(n => Number.isFinite(n) && n > 0);
}

/* ---------- Assign screens per showing (capacity probe with candidates) ---------- */
async function assignScreensPerShowing(pg, theaterName, rows, endISO, _versionByShowing, { dryRun = false } = {}) {
    let totalUpdated = 0;

    const provider = findWebdevProviderByName(theaterName);
    if (!provider || typeof provider.probeCapacityCandidate !== "function") {
        if (LOG_LEVEL !== "silent") {
            console.warn(`[prefill] provider for ${theaterName} lacks probeCapacityCandidate; keys=`, Object.keys(provider || {}));
        }
        return { assigned: false, updated: 0 };
    }

    for (const r of rows) {
        if (!r.purchase_url) continue;

        const candidates = await getKnownSeatCounts(pg, r.theater_id);
        if (!candidates.length) {
            if (LOG_LEVEL !== "silent") {
                console.warn(`[prefill] no screens configured for theater_id=${r.theater_id} (${theaterName}); cannot assign screen_id`);
            }
            continue;
        }

        let matched = null;
        for (const c of candidates) {
            const { ok } = await provider.probeCapacityCandidate({ showUrl: r.purchase_url }, c);
            if (LOG_LEVEL === "debug") {
                console.log(`[probe] ${theaterName} show ${r.showing_id} try ${c} -> ${ok ? "YES" : "NO"}`);
            }
            if (ok) { matched = c; break; }
        }
        if (!matched) continue;

        const screen_id = await mapCapacityToScreenId(pg, r.theater_id, matched);
        if (!screen_id) continue;

        if (dryRun) {
            if (LOG_LEVEL !== "silent") {
                const { dateISO, hhmm } = fmtLocal(r.start_at);
                console.log("[prefill/dryrun] set screen_id (per showing)", {
                    theaterName, showing_id: r.showing_id, screen_id, matched_capacity: matched, hhmm, dateISO
                });
            }
            totalUpdated += 1;
        } else {
            const sql = `
        UPDATE showings
           SET screen_id = $1
         WHERE id = $2
           AND screen_id IS NULL
           AND start_at BETWEEN NOW() AND ($3::date + INTERVAL '1 day' - INTERVAL '1 second')
      `;
            const { rowCount } = await pg.query(sql, [screen_id, r.showing_id, endISO]);
            if (!rowCount && LOG_LEVEL !== "silent") {
                const { dateISO, hhmm } = fmtLocal(r.start_at);
                console.warn(`[prefill] UPDATE skipped for showing ${r.showing_id} (${dateISO} ${hhmm}) — outside NOW..${endISO}?`);
            }
            totalUpdated += rowCount;
        }
    }

    return { assigned: totalUpdated > 0, updated: totalUpdated };
}

/* ------------------------------ MAIN ENTRY ------------------------------ */
export async function runNightPrefillWebdev({ allowTheaters = [], dryRun = false } = {}) {
    const pg = getClient(); await pg.connect();
    try {
        const all = await loadTargets(pg);
        const work = allowTheaters.length
            ? all.filter(r => allowTheaters.includes(r.theater_name))
            : all;

        if (!work.length) {
            if (LOG_LEVEL!=="silent") console.log("[prefill] nothing to do (after allowlist filter)");
            return;
        }

        // Group only for the **assignment** phase; URL fill is per-row
        const byKey = new Map();
        for (const r of work){
            const key = `${r.theater_id}:${r.movie_id}`;
            const arr = byKey.get(key) || [];
            arr.push(r); byKey.set(key, arr);
        }

        for (const rows of byKey.values()){
            const theaterName = rows[0].theater_name;
            const { dateISO: today } = fmtLocal(new Date().toISOString());
            const furthestISO = toISO(rows.reduce((a,b)=> (a.start_at > b.start_at ? a : b)).start_at);
            let endISO = furthestISO;
            const maxISO = addDays(today, MAX_LOOKAHEAD_DAYS);
            if (endISO > maxISO) endISO = maxISO;

            const { updates: filled, versionByShowing } =
                await fillPurchaseUrlsForShowings(pg, theaterName, rows, today, endISO, { dryRun });
            if (LOG_LEVEL!=="silent") console.log(
                `[prefill] ${theaterName} / movie ${rows[0].movie_id}: purchase_url filled=${filled}${dryRun?" (dryRun)":""}`
            );

            const res = await assignScreensPerShowing(pg, theaterName, rows, endISO, versionByShowing, { dryRun });
            if (LOG_LEVEL!=="silent") console.log("[prefill] assign(per-showing)", { theaterName, movie_id: rows[0].movie_id, ...res });
        }
    } finally {
        await pg.end();
    }
}
