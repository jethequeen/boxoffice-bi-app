#!/usr/bin/env node
// Usage:
//   node test/provider_runner.js --list
//   node test/provider_runner.js "<Theater Name>" <YYYY-MM-DD> <HH:MM> "<Movie Title>" [--locationId=...] [--showtimesKey=...] [--movieTitle=...] [--showUrl=...]
//   # URL-only mode (no positional args):
//   node test/provider_runner.js --showUrl="https://billetterie.cinemasrgfm.com/FR/Film-achat.awp?P1=01&P2=02&P3=215069" --theater="Cinéma RGFM Drummondville" [--date=YYYY-MM-DD] [--time=HH:MM] [--title="..."]
//
// Notes:
// - Cineplex still needs --locationId and --showtimesKey.
// - For WebDev no-seat providers you can pass --showUrl to probe directly.
// - On Windows PowerShell, keep quotes around names/titles with spaces or accents.
//
import { getSeatsByTheater } from "../scraper/provider_registry.js";

function parseFlags(argv) {
    const out = {};
    for (const a of argv) {
        const m = a.match(/^--([^=]+)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

async function main() {
    const [, , ...argv] = process.argv;

    // Quick "list" helper (stub)
    if (argv.length === 1 && argv[0] === "--list") {
        console.log(`(Tip) --list is not implemented in this script yet. Use your registry dumper or tests/test_webdev_cli.js if you have it.`);
        process.exit(0);
    }

    // Parse all flags once so we can support URL-only mode
    const allFlags = parseFlags(argv.filter(x => x.startsWith("--")));

    // MODE 3: URL-only probe (no positionals required)
    // requires: --showUrl and --theater
    if (allFlags.showUrl && (allFlags.theater || allFlags.t)) {
        const theaterName = allFlags.theater || allFlags.t;
        const dateISO = allFlags.date || todayISO();
        const hhmm = allFlags.time || "00:00";
        const title = (allFlags.title || allFlags.movieTitle || "(unknown)").trim();

        const mainArgs = { dateISO, hhmm, title, showUrl: allFlags.showUrl };

        try {
            const rec = await getSeatsByTheater(theaterName, mainArgs, allFlags);
            console.log("MATCH:", rec);
        } catch (e) {
            console.error("ERR:", e?.stack || e?.message || String(e));
            process.exit(2);
        }
        return;
    }

    // MODE 1: Normal positional args (back-compat)
    if (argv.length < 4) {
        console.log(`Usage:
  node test/provider_runner.js --list
  node test/provider_runner.js "<Theater Name>" <YYYY-MM-DD> <HH:MM> "<Movie Title>" [--locationId=...] [--showtimesKey=...] [--movieTitle=...] [--showUrl=...]
  # URL-only mode:
  node test/provider_runner.js --showUrl="https://.../Film-achat.awp?P1=..&P2=..&P3=.." --theater="Cinéma RGFM Drummondville" [--date=YYYY-MM-DD] [--time=HH:MM] [--title="..."]

Notes:
- For Cineplex, pass --locationId and --showtimesKey.
- For WebDev no-seat providers, --showUrl lets you probe directly without resolving from daily schedule.`);
        process.exit(1);
    }

    // Positional flow:
    const [theaterName, dateISO, hhmm, ...rest] = argv;
    const flags = parseFlags(rest.filter(x => x.startsWith("--")));
    const title = rest.filter(x => !x.startsWith("--")).join(" ").trim();

    const mainArgs = { dateISO, hhmm, title };
    if (flags.showUrl) mainArgs.showUrl = flags.showUrl;

    try {
        const rec = await getSeatsByTheater(theaterName, mainArgs, flags);
        console.log("MATCH:", rec);
    } catch (e) {
        console.error("ERR:", e?.stack || e?.message || String(e));
        process.exit(2);
    }
}

main();
