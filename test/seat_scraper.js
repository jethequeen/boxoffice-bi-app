#!/usr/bin/env node
/**
 * Minimal runner to test NEW WebDev providers using the SAME call path as the daemon.
 *
 * Positional usage (what you asked for):
 *   node test/run_webdev_like_daemon.js "<Theater Name>" <YYYY-MM-DD> <HH:MM> "<Movie Title>"
 *
 * Optional flags:
 *   --showUrl="https://billetterie.example.com/FR/Film-achat.awp?P1=..&P2=..&P3=.."
 *   --expectedCapacity=152
 *
 * Notes:
 * - Provider is forced to "webdev" (this is for new WebDev providers).
 * - We call getSeatsByTheater(theater, { dateISO, hhmm, title, showUrl?, expectedCapacity? }) — identical to the daemon.
 * - Output includes a compact summary and the raw record from the provider.
 */

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
    const [, , ...argv] = process.argv;
    const flags = parseFlags(argv.filter(a => a.startsWith("--")));
    const pos   = argv.filter(a => !a.startsWith("--"));

    if (pos.length < 4) {
        console.log(`Usage:
  node test/run_webdev_like_daemon.js "<Theater Name>" <YYYY-MM-DD> <HH:MM> "<Movie Title>"
  # Optional:
  node test/run_webdev_like_daemon.js "<Theater Name>" <YYYY-MM-DD> <HH:MM> "<Movie Title>" \\
      --showUrl="https://.../Film-achat.awp?..." --expectedCapacity=152
`);
        process.exit(1);
    }

    const [theater_name, dateISO, hhmm, ...rest] = pos;
    const title = rest.join(" ").trim();

    // Build args EXACTLY like the daemon’s tick() for webdev:
    const mainArgs = {
        dateISO,
        hhmm,
        title,
        ...(flags.showUrl ? { showUrl: flags.showUrl } : {}),
        ...(flags.expectedCapacity != null ? { expectedCapacity: Number(flags.expectedCapacity) } : {}),
    };

    try {
        const rec = await getSeatsByTheater(theater_name, mainArgs /* webdev → no opts object */);

        // Summarize like daemon’s measurement buffer (capacity & seats_sold if available)
        const capacity =
            rec?.sellable ?? rec?.raw?.sellable ?? (flags.expectedCapacity ? Number(flags.expectedCapacity) : null);
        const seats_remaining = rec?.seats_remaining ?? null;

        const out = {
            provider: "webdev",
            theater: theater_name,
            date: dateISO,
            time: hhmm,
            title,
            auditorium: rec?.auditorium ?? null,
            capacity,
            seats_remaining,
            source: rec?.source ?? "webdev",
        };

        if (capacity != null && seats_remaining != null) {
            const seats_sold_raw = capacity - seats_remaining;
            out.seats_sold = Math.max(0, Math.min(capacity, seats_sold_raw));
        }

        console.log(JSON.stringify({ MATCH: out, raw: rec }, null, 2));
    } catch (e) {
        console.error("ERR:", e?.stack || e?.message || String(e));
        process.exit(2);
    }
}

main();
