import { scrapeSeatsOnlyCinematheque } from "../insert/seats_sold_Cinematheque_quebecoise.js"

const [,, dateISO, hhmm, ...titleParts] = process.argv;
const title = (titleParts || []).join(" ").trim();

(async () => {
    try {
        console.log(`[debug] args: date=${dateISO} time=${hhmm} title=${title}`);
        const rec = await scrapeSeatsOnlyCinematheque({ movieTitle: title, local_date: dateISO, local_time: hhmm });
        console.log("MATCH:", rec);
    } catch (e) {
        console.error("ERR:", e.message);
        const list = await _debug_listDay(dateISO);
        console.log(`\n[debug] Found ${list.length} sessions on ${dateISO}:`);
        for (const s of list) {
            console.log(`- ${s.time} | ${s.title} | ${s.auditorium || "n/a"} | seatsRemaining=${s.seatsRemaining ?? "n/a"}`);
        }
    }
})();
