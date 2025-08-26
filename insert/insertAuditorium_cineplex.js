// insert/insertAuditorium_cineplex.js
import puppeteer from "puppeteer";

/* ---------- tiny helpers ---------- */
function todayInTZ(tz) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const [{ value: y }, , { value: m }, , { value: d }] = fmt.formatToParts(new Date());
    return `${y}-${m}-${d}`;
}
function toMDY(iso) { const [Y,M,D] = iso.split("-").map(Number); return `${M}/${D}/${Y}`; }
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const safe = (v) => (v == null ? "" : String(v));
function eachDate(a,b){const out=[];let d=new Date(a+"T00:00:00");const end=new Date(b+"T00:00:00");
    while(d<=end){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");
        out.push(`${y}-${m}-${day}`);d.setDate(d.getDate()+1);}return out;}
function previewUrlFor(row) {
    // Prefer provided seatMapUrl; otherwise build a desktop preview URL.
    if (row.seatMapUrl) return row.seatMapUrl.replace("/fr-Mobile/", "/fr/").replace("/en-Mobile/", "/en/");
    // Default to FR; change to /en/ if you prefer.
    return `https://www.cineplex.com/fr/ticketing/preview?theatreId=${row.theatreId}&showtimeId=${row.vistaSessionId}&dbox=false`;
}

/* ---------- config ---------- */
const CONFIG = {
    locationId: 9185,
    theatreUrl: "https://www.cineplex.com/fr/theatre/cinema-cineplex-odeon-brossard-et-vip?openTM=true",
    lang: "fr",
    start: todayInTZ("America/Toronto"),
    end:   todayInTZ("America/Toronto"),
};
const SHOWTIMES_PREFIX = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1/showtimes";

// optional one-arg filter
const TITLE_FILTER_RAW = (process.argv[2] || "").trim();
const hasFilter = TITLE_FILTER_RAW.length > 0;
const TITLE_FILTER = norm(TITLE_FILTER_RAW);
const matchesTitle = (title) => !hasFilter || (title && norm(title).includes(TITLE_FILTER));

/* ---------- normalize day-list payload ---------- */
function extractShowtimes(payload) {
    const data = Array.isArray(payload) ? payload : [payload];
    const rows = [];
    for (const blk of data) {
        const theatre = blk.theatre ?? blk.name ?? "";
        const theatreId = blk.theatreId ?? blk.locationId ?? "";
        for (const d of blk.dates ?? []) {
            const dateStr = (d.startDate || "").slice(0,10);
            for (const m of d.movies ?? []) {
                const movie = m.name ?? m.title ?? "";
                for (const xp of m.experiences ?? []) {
                    const experience = Array.isArray(xp.experienceTypes) ? xp.experienceTypes.join(" + ")
                        : (xp.experienceTypes ?? xp.name ?? "");
                    for (const s of xp.sessions ?? []) {
                        const iso  = s.showStartDateTime || s.startTime || "";
                        const time = iso.includes("T") ? iso.split("T")[1].slice(0,5) : iso;
                        rows.push({
                            theatre, theatreId, date: dateStr, time,
                            movie, experience,
                            auditorium: s.auditorium || s.screenName || s.auditoriumName || s.screenNumber || "",
                            vistaSessionId: s.vistaSessionId ?? s.showtimeId,
                            seatMapUrl: s.seatMapUrl || s.seatingUrl || null,
                            seatsRemaining: s.seatsRemaining ?? null,
                        });
                    }
                }
            }
        }
    }
    rows.sort((a,b)=>
        safe(a.theatre).localeCompare(safe(b.theatre)) ||
        safe(a.date).localeCompare(safe(b.date)) ||
        safe(a.time).localeCompare(safe(b.time)) ||
        safe(a.movie).localeCompare(safe(b.movie))
    );
    return rows;
}

/* ---------- counts from the preview page network (seat-availability / seat-layout) ---------- */
async function getCountsFromPreview(browser, row) {
    const p = await browser.newPage();
    // speed up: skip assets
    await p.setRequestInterception(true);
    p.on("request", (req) => {
        const t = req.resourceType();
        if (["image","font","stylesheet"].includes(t)) req.abort(); else req.continue();
    });

    let available = 0, occupied = 0;
    let sawUseful = false;

    p.on("response", async (res) => {
        const url = res.url();
        if (!/seat-availability|seat-layout/i.test(url)) return;
        try {
            const ctype = res.headers()["content-type"] || "";
            if (!/json/i.test(ctype)) return;
            const data = await res.json();

            // A) { seatAvailabilities: { "...": "Available" | "Occupied" | "Broken" | ... } }
            if (data && data.seatAvailabilities && typeof data.seatAvailabilities === "object") {
                available = 0; occupied = 0;
                for (const v of Object.values(data.seatAvailabilities)) {
                    const s = String(v).toLowerCase();
                    if (s === "available") available++;
                    else if (s === "occupied") occupied++;
                    // ignore broken/held/etc for capacity
                }
                sawUseful = true;
                return;
            }

            // B) { areas: [{ seats: [...] }...] } — count by status
            if (Array.isArray(data?.areas)) {
                available = 0; occupied = 0;
                for (const a of data.areas) {
                    for (const s of (a.seats || [])) {
                        const raw = (s.status ?? s.state ?? s.State ?? "").toString().toLowerCase();
                        const isAvail = s.available === true || raw === "available";
                        const isOcc   = s.isOccupied === true || raw === "occupied" || raw === "sold";
                        if (isAvail) available++; else if (isOcc) occupied++;
                    }
                }
                sawUseful = true;
                return;
            }
        } catch { /* ignore non-json */ }
    });

    // open preview, wait a tick for XHRs
    const url = previewUrlFor(row);
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await new Promise(r => setTimeout(r, 1200)); // give seat-availability calls time to finish
    await p.close();

    if (!sawUseful) return null;
    const capacity = available + occupied;
    return { capacity, remaining: available, sold: occupied };
}

/* ---------- minimal output ---------- */
function printSimple(r, counts) {
    if (counts && counts.capacity != null) {
        console.log(`${r.movie} | ${r.auditorium || "?"} | ${r.date} ${r.time} | sold ${counts.sold} / capacity ${counts.capacity}`);
    } else {
        const rem = r.seatsRemaining ?? "?";
        console.log(`${r.movie} | ${r.auditorium || "?"} | ${r.date} ${r.time} | remaining ${rem} / capacity ?`);
    }
}

/* ========================= MAIN ========================= */
(async () => {
    const { locationId, theatreUrl, lang, start, end } = CONFIG;

    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    // capture showtimes key (needed to pull the day list)
    let showtimesKey = null;
    page.on("request", (req) => {
        const url = req.url();
        if (url.startsWith(SHOWTIMES_PREFIX)) {
            const k = req.headers()["ocp-apim-subscription-key"];
            if (k) showtimesKey = k;
        }
    });
    await page.goto(theatreUrl, { waitUntil: "networkidle2" });
    if (!showtimesKey) await new Promise(r => setTimeout(r, 800));
    if (!showtimesKey) { await browser.close(); throw new Error("Could not capture showtimes key."); }

    const dates = eachDate(start, end);
    for (const iso of dates) {
        const mdy = toMDY(iso);
        const url = `${SHOWTIMES_PREFIX}?language=${encodeURIComponent(lang)}&locationId=${encodeURIComponent(String(locationId))}&date=${encodeURIComponent(mdy)}`;

        const res = await fetch(url, { headers: { Accept: "application/json", "Ocp-Apim-Subscription-Key": showtimesKey } });
        if (!res.ok) continue;

        const rows = extractShowtimes(await res.json());
        const filtered = rows.filter((r) => matchesTitle(r.movie));

        for (const r of filtered) {
            const counts = await getCountsFromPreview(browser, r);
            printSimple(r, counts);
        }
    }

    await browser.close();
})();
