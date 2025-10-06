#!/usr/bin/env node
// Usage:
//   node test/provider_runner.js --list
//   node test/provider_runner.js "<Theater Name>" <YYYY-MM-DD> <HH:MM> "<Movie Title>" [--locationId=...] [--showtimesKey=...] [--movieTitle=...]
//
// Examples (PowerShell):
//   node test/provider_runner.js "Maison du Cinéma" 2025-10-06 18:45 "Avatar : La voie de l'eau"
//   node test/provider_runner.js "Cinéma Saint-Eustache" 2025-10-06 12:50 "Le combattant VIP"
//   node test/provider_runner.js "Cineplex Odeon Quartier Latin" 2025-10-06 19:30 "Dune: Part Two" --locationId=1234 --showtimesKey=abcd1234
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

async function main() {
    const [, , ...args] = process.argv;


    if (args.length < 4) {
        console.log(`Usage:
  node test/provider_runner.js --list
  node test/provider_runner.js "<Theater Name>" <YYYY-MM-DD> <HH:MM> "<Movie Title>" [--locationId=...] [--showtimesKey=...] [--movieTitle=...]

Notes:
- For Cineplex, you MUST pass --locationId and --showtimesKey (we use your DB caching in the daemon; this CLI needs them explicitly).
- On Windows PowerShell, keep quotes around names/titles with spaces or accents.`);
        process.exit(1);
    }

    const [theaterName, dateISO, hhmm, ...rest] = args;
    const flags = parseFlags(rest.filter(x => x.startsWith("--")));
    const title = rest.filter(x => !x.startsWith("--")).join(" ").trim();

    try {
        const rec = await getSeatsByTheater(theaterName, { dateISO, hhmm, title }, flags);
        console.log("MATCH:", rec);
    } catch (e) {
        console.error("ERR:", e?.stack || e?.message || String(e));
        process.exit(2);
    }
}

main();
