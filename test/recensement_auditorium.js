// test/recensement_auditorium.js
// Snapshot today's showings for a WebDev theatre and write a CSV of measurements.
// Usage: node test/recensement_auditorium.js "Cinéma Saint-Eustache"

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findWebdevProviderByName } from "../scraper/webdev_providers.js";
import { isCineplexName } from "../scraper/provider_registry.js";

// --- Config ---
const TZ = "America/Toronto";
const CONCURRENCY = 6;   // reasonable parallelism
const OUTDIR = "out";    // CSV target folder

// --- tiny utils ---
function normName(s=""){
    return String(s).normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase().replace(/\s+/g," ").trim();
}
function todayISOInTZ(tz=TZ){
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    const [{value:Y},, {value:M},, {value:D}] = fmt.formatToParts(now);
    return `${Y}-${M}-${D}`;
}
function csvEscape(v){
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
    return s;
}
// simple p-limit
function pLimit(n){ let active=0,q=[];
    const run=async(fn,res,rej)=>{active++;try{res(await fn())}catch(e){rej(e)}finally{active--; if(q.length){const [f,r,j]=q.shift();run(f,r,j)}}};
    return (fn)=>new Promise((res,rej)=>{active<n?run(fn,res,rej):q.push([fn,res,rej])});
}

// --- core ---
async function main(){
    const [, , ...argv] = process.argv;
    const theaterName = (argv || []).join(" ").trim();
    if (!theaterName) {
        console.error('Usage: node test/webdev_auditorium_census.js "<Theatre Name>"');
        process.exit(2);
    }

    // Guardrails: WebDev only
    if (isCineplexName(theaterName)) {
        console.error(`[err] "${theaterName}" is a Cineplex venue. This census script targets WebDev theatres only.`);
        process.exit(2);
    }
    const provider = findWebdevProviderByName(theaterName);
    if (!provider) {
        console.error(`[err] No WebDev provider registered for "${theaterName}".`);
        process.exit(2);
    }

    const dateISO = todayISOInTZ(TZ);
    console.log(`[info] Theatre: ${theaterName}`);
    console.log(`[info] Date   : ${dateISO}`);

    // 1) Fetch today's show list (horaire) once
    let shows = [];
    try {
        shows = await provider.fetchDay(dateISO);
    } catch (e) {
        console.error("[err] fetchDay failed:", e?.message || e);
        process.exit(1);
    }

    if (!shows.length) {
        console.log("[info] No shows found for today.");
        process.exit(0);
    }

    // 2) Fetch auditorium + seats_remaining for each show
    const limit = pLimit(CONCURRENCY);
    const rows = await Promise.all(
        shows.map(s => limit(async () => {
            try {
                const rec = await provider.scrapeFromPurchaseUrl(s.url, dateISO);
                return {
                    ok: true,
                    title: s.title || "",
                    time:  s.time  || "",
                    auditorium: rec?.auditorium ?? "",
                    seats_remaining: Number.isFinite(rec?.seats_remaining) ? rec.seats_remaining : "",
                };
            } catch (e) {
                return {
                    ok: false,
                    title: s.title || "",
                    time:  s.time  || "",
                    auditorium: "",
                    seats_remaining: "",
                    error: e?.message || String(e),
                };
            }
        }))
    );

    // 3) Build CSV (no purchase_url, no measured_at)
    const headers = [
        "theater_name",
        "date",
        "title",
        "time",
        "auditorium",
        "seats_remaining",
        "status",
        "error",
    ];

    const lines = [headers.join(",")];
    for (const r of rows) {
        lines.push([
            csvEscape(theaterName),
            csvEscape(dateISO),
            csvEscape(r.title),
            csvEscape(r.time),
            csvEscape(r.auditorium),
            csvEscape(r.seats_remaining),
            csvEscape(r.ok ? "ok" : "fail"),
            csvEscape(r.error || ""),
        ].join(","));
    }

    // 4) Write CSV file
    const base = `auditorium_samples_${normName(theaterName).replace(/\s+/g,"-")}_${dateISO}.csv`;
    const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", OUTDIR, base);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, lines.join("\n"), "utf8");

    // 5) Console summary
    const total = rows.length;
    const ok = rows.filter(r => r.ok).length;
    const fail = total - ok;
    console.log(`[done] wrote ${outPath}`);
    console.log(`[sum ] shows=${total}, ok=${ok}, fail=${fail}`);

    if (fail) {
        const sample = rows.find(r => !r.ok);
        if (sample) {
            console.log(`[hint] first error: "${sample.error}" for "${sample.title}" @ ${sample.time}`);
        }
    }
}

main().catch(e => {
    console.error("Fatal:", e?.message || e);
    process.exit(1);
});
