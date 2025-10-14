// test/probe_window_to_csv.js
// Usage:
//   node test/probe_window_to_csv.js \
//     --theater="Cinéma RGFM Beloeil" \
//     --date=2025-10-15 \
//     --start=11:00 --end=14:00 \
//     --outfile=beloeil_1100_1400.csv \
//     [--concurrency=3] [--probe-timeout-ms=25000]
//
// What it does (NO DB, NO matching):
//  1) Loads the WebDev schedule for the given theater+date.
//  2) Keeps showings starting within [start,end] inclusive (local TZ).
//  3) For each showing, calls getSeatsByTheater with the schedule URL.
//  4) Writes CSV: theater,date,movie,time,seats_remaining,confirm_url,schedule_url,match_notes

import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";
import pLimit from "p-limit";

import { getScheduleByName } from "../scraper/webdev_providers.js";
import { getSeatsByTheater, classifyTheaterName } from "../scraper/provider_registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TZ = "America/Toronto";

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const m = argv[i].match(/^--([^=]+)=(.*)$/);
        if (m) args[m[1]] = m[2];
    }
    return args;
}

function csv(s){
    if (s == null) return "";
    const t = String(s);
    if (t.includes(",") || t.includes('"') || t.includes("\n")){
        return `"${t.replace(/"/g,'""')}"`;
    }
    return t;
}

// "HH:MM" -> minutes
function toMin(hhmm){
    const [H,M] = hhmm.split(":").map(Number);
    return H*60 + M;
}

// light normalization to help grouping
function normTitle(s=""){
    return s.normalize("NFD").replace(/\p{Diacritic}/gu,"")
        .replace(/\s+/g," ").trim();
}

async function main(){
    const args = parseArgs(process.argv);
    const theater = args.theater;
    const dateISO = args.date; // e.g. 2025-10-15
    const startHHMM = args.start || "11:00";
    const endHHMM   = args.end   || "14:00";
    const outPath   = path.resolve(args.outfile || `probe_${Date.now()}.csv`);
    const conc      = Math.max(1, Math.min(8, parseInt(args.concurrency || "3", 10)));
    const PROBE_TIMEOUT_MS = parseInt(args["probe-timeout-ms"] || "25000", 10);

    if (!theater || !dateISO){
        console.error('Missing required args. Example:\n  --theater="Cinéma RGFM Beloeil" --date=2025-10-15');
        process.exit(1);
    }

    // We only support WebDev theaters here (that’s where these helpers work)
    if (classifyTheaterName(theater) !== "webdev") {
        console.error(`This script expects a WebDev theater. Got: ${theater}`);
        process.exit(2);
    }

    // 1) Fetch schedule for the day
    const items = await getScheduleByName(theater, { dateISO, dump:false }) || [];
    // items: [{ title, time: "HH:MM", url, ... }]

    // 2) Filter by time window (inclusive)
    const sMin = toMin(startHHMM);
    const eMin = toMin(endHHMM);
    const inWindow = items.filter(it => it.url && it.time && toMin(it.time) >= sMin && toMin(it.time) <= eMin);

    if (!inWindow.length) {
        fs.writeFileSync(outPath, "info,No showings in the given time window\n");
        console.log(`No showings in window. Wrote: ${outPath}`);
        return;
    }

    // Deduplicate (some providers may list duplicates). Key by title+time+url
    const seen = new Set();
    const targets = [];
    for (const it of inWindow){
        const key = `${normTitle(it.title||"")}|${it.time}|${it.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(it);
    }

    // CSV header
    const lines = [];
    lines.push([
        "theater","date","movie","time",
        "seats_remaining","confirm_url","schedule_url","match_notes"
    ].join(","));

    const limit = pLimit(conc);

    await Promise.all(targets.map(it => limit(async () => {
        let capacity = "";
        let confirmUrl = "";
        let notes = "";

        try {
            // 3) Probe seats for this specific showing URL
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

            const rec = await getSeatsByTheater(
                theater,
                { dateISO, hhmm: it.time, title: it.title || "", showUrl: it.url, signal: ctrl.signal }
            );

            clearTimeout(timer);

            if (rec && typeof rec.seats_remaining === "number") {
                capacity = String(rec.seats_remaining);
            } else {
                notes = "no_seats_number";
            }

            // confirmation URL (best-effort: raw.confirm_url || confirm_url)
            confirmUrl = rec?.raw?.confirm_url || rec?.confirm_url || "";

            // include probe metadata if useful
            if (rec?.raw?.found_q !== undefined && rec?.raw?.probed_from !== undefined) {
                notes = `found_q=${rec.raw.found_q};from=${rec.raw.probed_from}`;
            }

        } catch (e) {
            notes = `probe_error:${(e && e.message) ? e.message : String(e)}`;
        }

        lines.push([
            csv(theater),
            csv(dateISO),
            csv(it.title || ""),
            csv(it.time),
            csv(capacity),
            csv(confirmUrl),
            csv(it.url),
            csv(notes)
        ].join(","));
    })));

    fs.writeFileSync(outPath, lines.join("\n"), "utf8");
    console.log(`CSV written: ${outPath}`);
}

main().catch(e => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
});
