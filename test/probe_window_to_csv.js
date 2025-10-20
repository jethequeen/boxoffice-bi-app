// test/probe_window_to_csv.js
//
// Focused seat-probe for a WebDev theater/time window and writes a CSV.
// If a probe hangs past MOVIE_HARD_TIMEOUT_MS, that movie is immediately
// suppressed for the rest of the run (force-skip), regardless of provider
// AbortController support.
//
// What it does (NO DB, NO matching):
//  1) Loads the WebDev schedule for the given theater+date.
//  2) Keeps showings starting within [start,end] inclusive (local TZ).
//  3) For each showing, calls getSeatsByTheater with the schedule URL.
//  4) Writes CSV: theater,date,movie,time,seats_remaining,confirm_url,schedule_url,match_notes

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pLimit from "p-limit";

import { getScheduleByName } from "../scraper/webdev_providers.js";
import { getSeatsByTheater, classifyTheaterName } from "../scraper/provider_registry.js";

/* --------------------------- HARD-CODED CONFIG --------------------------- */
const THEATER               = "Cinéma Capitol Drummondville";
const DATE_ISO              = "2025-10-23";
const START_HHMM            = "18:00";
const END_HHMM              = "20:00";
const OUTFILE_PATH          = "./capitole_probe.csv";
const CONCURRENCY           = 2;

// We still keep a per-request "soft" timeout via AbortController,
// but the real guard is MOVIE_HARD_TIMEOUT_MS (Promise.race cutoff).
const PROBE_TIMEOUT_MS      = 15_000;   // soft per-showing abort (if provider honors signal)
const MOVIE_HARD_TIMEOUT_MS = 300_000;   // hard cutoff: after this, force-skip the movie

const SCHEDULE_TIMEOUT_MS   = 20_000;
const WATCHDOG_MS           = 300_000*10;
const DEBUG                 = true;
const DUMP_DIR              = null;     // "./_debug_dumps"
/* ------------------------------------------------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function csv(s){
    if (s == null) return "";
    const t = String(s);
    if (t.includes(",") || t.includes('"') || t.includes("\n")){
        return `"${t.replace(/"/g,'""')}"`;
    }
    return t;
}
function toMin(hhmm){
    const [H,M] = (hhmm || "").split(":").map(Number);
    return (H|0)*60 + (M|0);
}
function normTitle(s=""){
    return s.normalize("NFD").replace(/\p{Diacritic}/gu,"")
        .replace(/\s+/g," ").trim();
}

// Promise.race cutoff that **detaches** the underlying promise on timeout
async function withHardCutoff(promise, ms, label){
    let finished = false;
    const cutoff = new Promise((_, rej) => {
        setTimeout(() => {
            if (!finished) rej(Object.assign(new Error("cutoff"), { code: "CUTOFF" }));
        }, ms);
    });
    try {
        const res = await Promise.race([promise, cutoff]);
        finished = true;
        return res;
    } catch (e) {
        if (e && e.code === "CUTOFF") {
            // Detach the original promise so it can't block; silence any late errors.
            promise.then(() => {
                if (DEBUG) console.log(`[detached:${label}] resolved after cutoff`);
            }).catch(err => {
                if (DEBUG) console.log(`[detached:${label}] rejected after cutoff: ${err?.message || err}`);
            });
        }
        throw e;
    }
}

async function main(){
    const outPath = path.resolve(__dirname, OUTFILE_PATH);

    if (classifyTheaterName(THEATER) !== "webdev") {
        console.error(`Expected WebDev theater. Got ${THEATER}`);
        fs.writeFileSync(outPath, `error,expected_webdev_provider_for,${csv(THEATER)}\n`);
        return;
    }

    const lines = [];
    lines.push("theater,date,movie,time,seats_remaining,confirm_url,schedule_url,match_notes");

    const watchdog = setTimeout(() => {
        console.error(`[watchdog] force-exit after ${WATCHDOG_MS}ms`);
        fs.writeFileSync(outPath, lines.join("\n"), "utf8");
        process.exit(99);
    }, WATCHDOG_MS);

    if (DEBUG) console.log(`[debug] fetching schedule for ${THEATER} @ ${DATE_ISO}`);
    const schedCtrl = new AbortController();
    const schedTimer = setTimeout(() => schedCtrl.abort("schedule_timeout"), SCHEDULE_TIMEOUT_MS);

    let items = [];
    try {
        items = await getScheduleByName(THEATER, { dateISO: DATE_ISO, dump: false, signal: schedCtrl.signal }) || [];
    } catch (e) {
        const msg = e?.message || String(e);
        console.error(`[schedule] ${msg}`);
        fs.writeFileSync(outPath, `error,${csv(msg)}\n`);
        clearTimeout(watchdog);
        return;
    }
    clearTimeout(schedTimer);
    if (DEBUG) console.log(`[debug] schedule items loaded: ${items.length}`);

    const sMin = toMin(START_HHMM);
    const eMin = toMin(END_HHMM);
    const inWindow = items.filter(it => it?.url && it?.time && toMin(it.time) >= sMin && toMin(it.time) <= eMin);

    if (DEBUG) console.log(`[debug] in-window items: ${inWindow.length} (between ${START_HHMM} and ${END_HHMM})`);
    if (!inWindow.length) {
        fs.writeFileSync(outPath, "info,No showings in window\n");
        clearTimeout(watchdog);
        return;
    }

    // Deduplicate by title+time+url
    const seen = new Set();
    const targets = [];
    for (const it of inWindow){
        const key = `${normTitle(it.title||"")}|${it.time}|${it.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(it);
    }
    if (DEBUG) console.log(`[debug] dedup targets: ${targets.length}`);

    const limit = pLimit(CONCURRENCY);
    const suppressedByMovie = new Set();
    let idx = 0;

    await Promise.all(targets.map(it => limit(async () => {
        const myIdx = ++idx;
        const titleNorm = normTitle(it.title || "");
        if (suppressedByMovie.has(titleNorm)) {
            if (DEBUG) console.log(`[debug][${myIdx}] SKIP (suppressed) ${titleNorm} @ ${it.time}`);
            lines.push([csv(THEATER),csv(DATE_ISO),csv(it.title||""),csv(it.time),"","","","skipped_after_force_skip"].join(","));
            return;
        }

        if (DEBUG) console.log(`[debug][${myIdx}/${targets.length}] probing ${titleNorm} @ ${it.time}`);

        let capacity   = "";
        let confirmUrl = "";
        let notes      = "";

        // Provider call (may ignore AbortController), wrap with hard cutoff
        const providerCall = (async () => {
            // Soft timeout via AbortController (best-effort)
            const ctrl = new AbortController();
            const softTimer = setTimeout(() => ctrl.abort("soft_timeout"), PROBE_TIMEOUT_MS);
            try {
                const rec = await getSeatsByTheater(
                    THEATER,
                    { dateISO: DATE_ISO, hhmm: it.time, title: it.title||"", showUrl: it.url, signal: ctrl.signal }
                );
                return rec;
            } finally {
                clearTimeout(softTimer);
            }
        })();

        try {
            const rec = await withHardCutoff(providerCall, MOVIE_HARD_TIMEOUT_MS, `${titleNorm}|${it.time}`);

            // Heuristic: detect seatmap flow if provider exposes it
            const looksSeatmap = rec?.raw?.seatmap === true || rec?.raw?.kind === "seatmap";
            if (looksSeatmap) {
                suppressedByMovie.add(titleNorm);
                notes = "provider_seatmap_detected";
            }

            if (typeof rec?.seats_remaining === "number") {
                capacity = String(rec.seats_remaining);
            } else if (!notes) {
                notes = "no_seats_number";
            }

            confirmUrl = rec?.raw?.confirm_url || rec?.confirm_url || "";
        } catch (e) {
            if (e && e.code === "CUTOFF") {
                // Hard cutoff → suppress movie immediately
                console.error(`[force-skip] ${titleNorm} exceeded ${MOVIE_HARD_TIMEOUT_MS}ms, skipping movie`);
                suppressedByMovie.add(titleNorm);
                notes = `probe_error:force_skip`;
            } else if (e?.name === "AbortError") {
                // Soft timeout (provider honored AbortController)
                suppressedByMovie.add(titleNorm);
                notes = `probe_error:timeout`;
                if (DEBUG) console.log(`[debug][${myIdx}] soft-timeout → suppress ${titleNorm}`);
            } else {
                const msg = e?.message || String(e);
                notes = `probe_error:${msg}`;
                if (DEBUG) console.log(`[debug][${myIdx}] error: ${msg}`);
            }
        }

        lines.push([
            csv(THEATER),
            csv(DATE_ISO),
            csv(it.title || ""),
            csv(it.time),
            csv(capacity),
            csv(confirmUrl),
            csv(it.url),
            csv(notes)
        ].join(","));
    })));

    fs.writeFileSync(outPath, lines.join("\n"), "utf8");
    console.log(`CSV written: ${path.resolve(outPath)}`);
    clearTimeout(watchdog);
}

main().catch(e => {
    console.error(e?.stack || e);
    process.exit(1);
});
