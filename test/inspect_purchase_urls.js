// test/inspect_purchase_urls.js
// Run: node test/inspect_purchase_urls.js
import { getClient } from "../db/client.js";
import { getScheduleByName, findWebdevProviderByName } from "../scraper/webdev_providers.js";
import { classifyTheaterName } from "../scraper/provider_registry.js";

try {
    const { config } = await import("dotenv");
    config({ path: ".env", override: false });
    config({ path: ".env.txt", override: false });
} catch {}

const CONFIG = {
    tz: "America/Toronto",
    theaters: ["Cinéma RGFM Beloeil"],   // ⬅️ hard-coded test target
    daysSpan: 3,                         // today, +1, +2 (local)
    onlyMissingPurchaseUrl: false,
    allowProviderKinds: ["notDisplayingSeats", "displayingSeats"],
    limit: 2000,
    dumpSchedule: false,
};

const TZ = CONFIG.tz;
const LOG_PREFIX = "[inspect]";

/* ---------------- time helpers ---------------- */
function todayInTZ(tz) {
    const now = new Date();
    const df = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric",month:"2-digit",day:"2-digit" });
    const [{value:Y},, {value:M},, {value:D}] = df.formatToParts(now);
    return `${Y}-${M}-${D}`;
}
function addDaysISO(dateISO, days){
    const d = new Date(`${dateISO}T00:00:00-00:00`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0,10);
}
function fmtLocal(iso){
    const d=new Date(iso);
    const df=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
    const tf=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
    const [{value:Y},, {value:M},, {value:D}] = df.formatToParts(d);
    const [{value:HH},, {value:mm}] = tf.formatToParts(d);
    return { dateISO: `${Y}-${M}-${D}`, hhmm: `${HH}:${mm}` };
}

/* -------------- normalization helpers -------------- */
const NOISE_RE = /\b(VF|VOA?|VOST(?:FR)?|IMAX|ATMOS|4DX|D-?BOX|HFR|3D|2D|Dolby(?:\s+Cinema)?)\b/gi;
function baseNormalize(s=""){
    return s.normalize("NFD").replace(/\p{Diacritic}/gu,"")
        .replace(NOISE_RE, " ")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/[’']/g, " ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/^(le|la|les|the|l|un|une)\s+/g, "")
        .trim();
}
function tokens(s=""){
    return baseNormalize(s).split(" ").filter(Boolean);
}
function normFlat(s=""){
    // super-permissive “LIKE” string: remove spaces to survive truncation/punctuation
    return baseNormalize(s).replace(/\s+/g,"");
}

/* ---------------- current (old) picker ---------------- */
function pickUrlForShow_old(items, hhmm, movieTitle) {
    const list = (items || []).filter(it => it && it.url && it.time);
    if (!list.length) return { url: "", strategy: "no-items" };

    const tgtTitleFlat = normFlat(movieTitle);
    const atTime = list.filter(it => it.time === hhmm);
    if (!atTime.length) return { url: "", strategy: "no-time-match" };

    if (atTime.length === 1) return { url: atTime[0].url, strategy: "time-only-single" };

    // “light equality”
    const exact = atTime.find(it => normFlat(it.title || "") === tgtTitleFlat);
    if (exact) return { url: exact.url, strategy: "time+title-light" };

    // token overlap similarity (old threshold was ~0.78; that was too strict)
    let best=null, bestScore=-1;
    const tgtTokens = new Set(tokens(movieTitle));
    for (const it of atTime){
        const cand = new Set(tokens(it.title || ""));
        let inter = 0; for (const x of cand) if (tgtTokens.has(x)) inter++;
        const sc = cand.size ? inter / Math.max(cand.size, tgtTokens.size) : 0;
        if (sc > bestScore) { best = it; bestScore = sc; }
    }
    if (best && bestScore >= 0.5) return { url: best.url, strategy: `time+title-sim(${bestScore.toFixed(2)})` };

    return { url: "", strategy: "time-match-but-title-weak" };
}

/* ---------------- super-simple “LIKE” picker ----------------
   Rules:
   1) Same time → candidates.
   2) If one: pick it.
   3) Containment (normFlat) in either direction → pick first that matches.
   4) Token overlap ≥ 2 significant tokens → pick the one with max overlap.
   5) Fallback: first candidate (deterministic).
----------------------------------------------------------------*/
function pickUrlForShow_simple(items, hhmm, movieTitle) {
    const list = (items || []).filter(it => it && it.url && it.time);
    if (!list.length) return { url: "", why: "no-items" };

    const atTime = list.filter(it => it.time === hhmm);
    if (!atTime.length) return { url: "", why: "no-time-match" };
    if (atTime.length === 1) return { url: atTime[0].url, why: "single-at-time" };

    const tgtFlat = normFlat(movieTitle);
    const tgtToks = tokens(movieTitle);

    // (3) containment either way (handles truncation like “… : L”, “V.O.” suffix, etc.)
    for (const it of atTime) {
        const candFlat = normFlat(it.title || "");
        if (!candFlat) continue;
        if (tgtFlat.includes(candFlat) || candFlat.includes(tgtFlat)) {
            return { url: it.url, why: `containment(${candFlat.length}chars)` };
        }
    }

    // (4) token overlap ≥ 2
    let best = null, bestInter = -1, bestWhy = "";
    for (const it of atTime) {
        const candToks = tokens(it.title || "");
        let inter = 0;
        for (const t of candToks) if (tgtToks.includes(t)) inter++;
        if (inter > bestInter) {
            best = it; bestInter = inter; bestWhy = `token-overlap(${inter})`;
        }
    }
    if (best && bestInter >= 2) return { url: best.url, why: bestWhy };

    // (5) deterministic fallback
    return { url: atTime[0].url, why: "fallback-first" };
}

/* ---------------- DB: fetch Beloeil for local 3-day window ---------------- */
async function loadShowings(pg) {
    const startDate = todayInTZ(TZ);
    const endDate   = addDaysISO(startDate, CONFIG.daysSpan - 1); // inclusive
    const condMissing = CONFIG.onlyMissingPurchaseUrl ? "AND s.purchase_url IS NULL" : "";
    const condTheaters = CONFIG.theaters.length ? `AND t.name = ANY($4)` : "";

    const sql = `
    SELECT s.id AS showing_id, s.movie_id, s.theater_id, s.start_at, s.purchase_url,
           COALESCE(m.fr_title, m.title) AS movie_title,
           t.name AS theater_name
      FROM showings s
      JOIN theaters t ON t.id = s.theater_id
      JOIN movies   m ON m.id = s.movie_id
     WHERE (s.start_at AT TIME ZONE $1) >= ($2::date)
       AND (s.start_at AT TIME ZONE $1) <  ($3::date + INTERVAL '1 day')
       ${condMissing}
       ${condTheaters}
     ORDER BY t.name, m.title, s.start_at
     LIMIT $5
  `;
    const params = [TZ, startDate, endDate, CONFIG.theaters.length ? CONFIG.theaters : null, CONFIG.limit];
    const { rows } = await pg.query(sql, params);
    return rows;
}

async function ensureScheduleCached(cache, theaterName, dateISO) {
    const key = `${theaterName}::${dateISO}`;
    if (!cache.has(key)) {
        const sched = await getScheduleByName(theaterName, { dateISO, dump: false });
        cache.set(key, Array.isArray(sched) ? sched : []);
    }
    return cache.get(key);
}

/* -------------------------------- main ---------------------------------- */
(async function main(){
    const pg = getClient(); await pg.connect();
    try {
        const raw = await loadShowings(pg);

        const s2 = raw.filter(r => classifyTheaterName(r.theater_name) === "webdev");
        const s3 = [];
        for (const r of s2) {
            const prov = findWebdevProviderByName(r.theater_name);
            const kind = prov?.kind || "(none)";
            if (CONFIG.allowProviderKinds.includes(kind)) s3.push(r);
        }

        console.log(`${LOG_PREFIX} Window (local ${TZ}): today..+${CONFIG.daysSpan-1} days`);
        console.log(`${LOG_PREFIX}   theaters: ${JSON.stringify(CONFIG.theaters)}`);
        console.log(`${LOG_PREFIX}   fetched (SQL): ${raw.length}`);
        console.log(`${LOG_PREFIX}   after classify(webdev): ${s2.length}`);
        console.log(`${LOG_PREFIX}   after provider kind ${JSON.stringify(CONFIG.allowProviderKinds)}: ${s3.length}\n`);

        if (!s3.length) {
            console.log(`${LOG_PREFIX} nothing to inspect (double-check exact theater name).`);
            return;
        }

        const scheduleCache = new Map();
        let inspected = 0;

        console.log(`${LOG_PREFIX} inspecting ${s3.length} showings\n`);

        for (const r of s3) {
            const { dateISO, hhmm } = fmtLocal(r.start_at);
            const sched = await ensureScheduleCached(scheduleCache, r.theater_name, dateISO);

            // OLD vs SIMPLE
            const oldPick = pickUrlForShow_old(sched, hhmm, r.movie_title);
            const simplePick = pickUrlForShow_simple(sched, hhmm, r.movie_title);

            const sameTime = (sched || []).filter(it => it.time === hhmm)
                .map(it => ({ title: (it.title || "").trim(), url: it.url }));

            console.log(`${LOG_PREFIX} ${r.theater_name}`);
            console.log(`  date/time:            ${dateISO} ${hhmm} ${TZ}`);
            console.log(`  showing_id:           ${r.showing_id}`);
            console.log(`  movie:                ${r.movie_title}`);
            console.log(`  existing_url:         ${r.purchase_url || ""}`);
            console.log(`  old_predicted_url:    ${oldPick.url || ""}`);
            console.log(`  old_strategy:         ${oldPick.strategy}`);
            console.log(`  simple_predicted_url: ${simplePick.url || ""}`);
            console.log(`  simple_reason:        ${simplePick.why}`);

            if (!sameTime.length) {
                console.log(`  candidates:           (none at ${hhmm})`);
            } else {
                console.log(`  candidates@${hhmm}:`);
                for (const c of sameTime) console.log(`    - "${c.title}" -> ${c.url}`);
            }

            if (CONFIG.dumpSchedule) {
                const dump = (sched || []).map(it => `${it.time} | ${it.title || ""} | ${it.url}`).join("\n");
                console.log(`  --- full schedule dump for ${dateISO} ---\n${dump || "(empty)"}\n  ------------------------------------------`);
            }

            console.log("");
            inspected++;
        }

        console.log(`${LOG_PREFIX} done. inspected=${inspected}`);
    } catch (e) {
        console.error(`${LOG_PREFIX} error:`, e?.stack || e);
    } finally {
        await pg.end();
    }
})();
