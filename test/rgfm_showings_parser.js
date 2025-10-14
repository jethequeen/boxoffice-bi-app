#!/usr/bin/env node
// tests/test_webdev_cli.js
import process from "process";

// adjust the path if your tree differs
import {
    findWebdevProviderByName,
    getScheduleByName,
    getSeatsByName,
    listWebdevTheaters,
} from "../scraper/webdev_providers.js";

function usage(msg) {
    if (msg) console.error(`\nError: ${msg}\n`);
    console.log(`Usage:
  # List showings (works for *all* providers if they expose getSchedule)
  node tests/test_webdev_cli.js --theater "Cinéma RGFM Drummondville" --date 2025-10-14 [--dump]

  # Fetch seat map (seat-flow providers only) after you know time/title
  node tests/test_webdev_cli.js --theater "Cinéma Beaubien" --date 2025-10-14 --seats --hhmm 19:00 --title "Dune: Part Two"

  # Show all registered theater names
  node tests/test_webdev_cli.js --list
`);
    process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
    const args = { dump: false, seats: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case "--theater": case "-t": args.theater = next(); break;
            case "--date":    case "-d": args.dateISO = next(); break;
            case "--hhmm":               args.hhmm = next(); break;
            case "--title":              args.title = next(); break;
            case "--dump":               args.dump = true; break;
            case "--seats":              args.seats = true; break;
            case "--list":               args.list = true; break;
            case "--help": case "-h":    usage(); break;
            default:
                if (a.startsWith("-")) usage(`Unknown flag: ${a}`);
        }
    }
    return args;
}

function todayISO() {
    const now = new Date();
    const m = String(now.getMonth()+1).padStart(2,"0");
    const d = String(now.getDate()).padStart(2,"0");
    return `${now.getFullYear()}-${m}-${d}`;
}

function printSchedule(items) {
    if (!items?.length) return console.log("No showings.");
    console.log(`Found ${items.length} showings:\n`);
    for (const s of items) {
        const t = s.time || "??:??";
        const title = s.title || "(n/a)";
        const url = s.url || "(no url)";
        console.log(`• ${t.padEnd(5)} | ${title} -> ${url}${s.p3 ? ` (P3=${s.p3})` : ""}`);
    }
}

(async function main() {
    const args = parseArgs(process.argv);

    if (args.list) {
        console.log("\nRegistered theaters:\n");
        for (const n of listWebdevTheaters()) console.log(" -", n);
        console.log("");
        return;
    }

    if (!args.theater) usage("Missing --theater");
    const dateISO = args.dateISO || todayISO();

    const provider = findWebdevProviderByName(args.theater);
    if (!provider) usage(`No provider configured for "${args.theater}"`);

    const canSchedule = typeof provider.getSchedule === "function";
    const canSeats    = typeof provider.getSeats === "function";

    if (args.seats) {
        if (!canSeats) usage(`"${args.theater}" does not expose seats. Omit --seats to list showings.`);
        if (!args.hhmm || !args.title) usage("Seat map requires --hhmm and --title.");
        console.log(`\n[Seat map] ${args.theater} — ${dateISO} @ ${args.hhmm} — ${args.title}\n`);
        const resp = await getSeatsByName(args.theater, {
            dateISO, hhmm: args.hhmm, title: args.title, dump: args.dump,
        });
        console.dir(resp, { depth: 6, colors: true });
    } else {
        if (!canSchedule) usage(`"${args.theater}" exposes seats only; pass --seats with --hhmm and --title.`);
        console.log(`\n[Schedule] ${args.theater} — ${dateISO}\n`);
        const items = await getScheduleByName(args.theater, { dateISO, dump: args.dump });
        printSchedule(items);
    }
})().catch(err => {
    console.error("\nTest failed:", err?.stack || err);
    process.exit(1);
});
