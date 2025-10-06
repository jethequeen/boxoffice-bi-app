// test/webdev_runner.js
import { getSeats, providers } from "../scraper/webdev_providers.js";
import { setGlobalDispatcher, Agent } from "undici";

// Force HTTP/1.1 and give generous timeouts during debug
setGlobalDispatcher(new Agent({
    allowH2: false,
    connect: { timeout: 15000 },
    headersTimeout: 20000,
    bodyTimeout: 30000,
    keepAliveTimeout: 30_000,
    pipelining: 1,
}));

const [,, providerKey, dateISO, time, ...titleParts] = process.argv;

(async () => {
    try {
        if (!providerKey || !dateISO) {
            console.log("Usage:");
            console.log("  node insert/webdev_cli.js <providerKey> <YYYY-MM-DD> [HH:MM] [title…]");
            console.log("\nKnown providers:", Object.keys(providers).join(", "));
            process.exit(1);
        }

        if (!time) {
            // list showings for the day
            const list = await providers[providerKey].fetchDay(dateISO);
            console.log(`[debug] ${providerKey} shows on ${dateISO}: ${list.length}`);
            for (const s of list) console.log(`- ${s.time || "??:??"} | ${s.title} | ${s.url}`);
            return;
        }

        const title = (titleParts || []).join(" ").trim();
        const rec = await getSeats(providerKey, { dateISO, hhmm: time, title });
        console.log("MATCH:", rec);
    } catch (e) {
        console.error("ERR:", e?.stack || e?.message || String(e));
        process.exit(2);
    }
})();
