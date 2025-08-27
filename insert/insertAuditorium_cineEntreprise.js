import { chromium } from "playwright";
import minimist from "minimist";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const args = minimist(process.argv.slice(2));
const { url, date, time, film, index, debug } = args;

if (!url) {
    console.error('Usage: node cineEntreprise_seats.playwright.mjs --url "<cinema-or-film-page-url>" [--date YYYY-MM-DD] [--time HH:MM] [--film HO0000..] [--index N] [--debug]');
    process.exit(1);
}

const toMDY = iso => {
    if (!iso) return null;
    const [Y, M, D] = iso.split("-").map(Number);
    return `${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}-${Y}`;
};
const fromMDY_HM = (mdy, hm) => {
    const [M, D, Y] = mdy.split("-").map(Number);
    const [h, m] = hm.split(":").map(Number);
    return new Date(Y, M-1, D, h, m, 0, 0);
};

function summarizeSeatLayout(json) {
    const areas = json?.ResponseData?.Areas || [];
    let capacity = 0, available = 0, sold = 0;
    const statusBreakdown = {};
    for (const a of areas) {
        capacity += a.NumberOfSeats || 0;
        for (const r of a.Rows || []) {
            for (const s of r.Seats || []) {
                const id = s.Id ?? s.id;
                const col = s.Position?.ColumnIndex ?? s.position?.columnIndex;
                if (id == null || typeof col !== "number" || col < 0) continue;
                const st = Number(s.Status ?? s.status ?? -1);
                statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;
                if (st === 0) available++; else sold++;
            }
        }
    }
    return { capacity, available, sold, statusBreakdown };
}

async function readButtons(page) {
    return await page.evaluate(() => {
        const parse = (el) => {
            const p = el.getAttribute("params") || "";
            const get = (re) => (p.match(re)?.[1] ?? "");
            return {
                time: get(/html:\s*'([^']+)'/),
                date: get(/date:\s*'([^']+)'/),
                film: get(/currentFilm:\s*{[^}]*Value:\s*'([^']+)'/),
                title: get(/currentFilm:\s*{[^}]*Label:\s*'([^']+)'/),
                sessionID: get(/sessionID:\s*'([^']+)'/),
                cinemaId: get(/cinemaId:\s*'([^']+)'/)
            };
        };
        return [...document.querySelectorAll("add-ticket-modal-btn[params]")].map(parse);
    });
}

async function ensureButtonsOnPage(page, baseUrl) {
    for (let i=0;i<4;i++){
        await page.evaluate(y => window.scrollTo(0, document.body.scrollHeight*(y+1)/4), i);
        await sleep(200);
    }
    let has = await page.$("add-ticket-modal-btn[params]");
    if (!has && /\/horaires\b/i.test(baseUrl)) {
        const fallback = baseUrl.replace(/\/horaires\b/i, "");
        await page.goto(fallback, { waitUntil: "networkidle", timeout: 0 });
        for (let i=0;i<4;i++){
            await page.evaluate(y => window.scrollTo(0, document.body.scrollHeight*(y+1)/4), i);
            await sleep(200);
        }
        has = await page.$("add-ticket-modal-btn[params]");
    }
    return !!has;
}

async function triggerShowtime(page, sessionID) {
    // Prefer calling Knockout VM's open()
    const ok = await page.evaluate((sid) => {
        const nodes = [...document.querySelectorAll("add-ticket-modal-btn[params]")];
        for (const el of nodes) {
            const p = el.getAttribute("params") || "";
            if (!p.includes(`sessionID: '${sid}'`)) continue;
            try {
                if (window.ko) {
                    const vm = window.ko.dataFor(el);
                    if (vm && typeof vm.open === "function") { vm.open(); return true; }
                }
            } catch {}
            const btn = el.querySelector("button");
            if (btn) { btn.click(); return true; }
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return true;
        }
        return false;
    }, sessionID);
    if (!ok) throw new Error("Could not trigger showtime");
}

async function forceCart(page, sessionID, cinemaId) {
    const cartUrl = `https://www.cinentreprise.com/cart?sessionId=${encodeURIComponent(sessionID)}&cinemaId=${encodeURIComponent(cinemaId||"")}`;
    await page.goto(cartUrl, { waitUntil: "networkidle", timeout: 0 });
}

async function domFallbackCounts(page) {
    return await page.evaluate(() => {
        const nodes = document.querySelectorAll(".seat-map__rows .seat-map__seat, .seat-map__seat--rowName");
        const classify = (el) => {
            const c = (el.className || "").toLowerCase();
            const title = (el.getAttribute("title") || "").toLowerCase();
            const text = (el.textContent || "").trim();
            const avail = /available|disponible/.test(c) || /disponible/.test(title);
            const sold  = /occup[ée]|sold|pris/.test(c) || /occup|sold|pris/.test(title);
            const selected = /selected|choisi/.test(c) || /choisi/.test(title);
            const blocked  = /social|distanc|blocked|bloqu/.test(c) || /distanc/.test(title);
            const wheelchair = /wheel|fauteuil/.test(c) || /fauteuil|wheel/.test(title);
            return { avail, sold, selected, blocked, wheelchair, text };
        };
        let capacity = 0, available = 0, sold = 0;
        for (const el of nodes) {
            const { avail, sold: sld, selected: sel, blocked: blk, wheelchair, text } = classify(el);
            const looksLikeSeat = /^\d+$/.test(text) || avail || sld || sel || blk || wheelchair;
            if (!looksLikeSeat) continue;
            capacity++;
            if (avail) available++; else sold++;
        }
        return { capacity, available, sold };
    });
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox"]
    });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "networkidle", timeout: 0 });

    if (!await ensureButtonsOnPage(page, url)) {
        console.error("No showtime buttons found on the page.");
        await browser.close();
        process.exit(2);
    }

    const all = await readButtons(page);

    const wantMDY = date ? toMDY(date) : null;
    const wantTime = time || null;
    const wantFilm = film || null;

    let candidates = all.filter(x => x.sessionID);
    if (wantFilm) candidates = candidates.filter(x => x.film === wantFilm);
    if (wantMDY)  candidates = candidates.filter(x => x.date === wantMDY);
    if (wantTime) candidates = candidates.filter(x => x.time === wantTime);
    if (!candidates.length) candidates = all;

    let picked;
    if (index != null) {
        picked = candidates[Number(index)] || null;
    } else {
        const now = new Date();
        const scored = candidates.map(x => ({ x, dt: (x.date && x.time) ? fromMDY_HM(x.date, x.time) : new Date(8640000000000000) }));
        const fut = scored.filter(s => s.dt > now).sort((a,b)=>a.dt-b.dt);
        picked = (fut[0]?.x) || scored.sort((a,b)=>a.dt-b.dt)[0]?.x || null;
    }
    if (!picked) {
        console.error("Could not choose a session from this URL.");
        await browser.close();
        process.exit(3);
    }

    if (debug) console.error("Picked:", picked);

    // Try to catch the seat-plan response while we trigger the flow
    const seatPlanPromise = page.waitForResponse(
        r => /ticketingapi\/GetSessionSeatPlan/i.test(r.url()) && r.request().method() === "POST",
        { timeout: 20000 }
    ).catch(() => null);

    // Knockout open (or click)
    await triggerShowtime(page, picked.sessionID);

    // Race: seat-plan arrives OR a modal appears OR we navigate
    const raced = await Promise.race([
        seatPlanPromise,
        page.waitForSelector(".seat-map__wrapper, #seat-map, [class*='seat-map']", { timeout: 8000 }).catch(() => null),
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 8000 }).catch(() => null),
    ]);

    // If nothing obvious happened, force the /cart route, which always leads to seat plan
    if (!raced) {
        await forceCart(page, picked.sessionID, picked.cinemaId);
    }

    // If we still don't have the XHR, wait once more (some flows delay it)
    const resp = raced && typeof raced.json === "function"
        ? raced
        : await page.waitForResponse(
            r => /ticketingapi\/GetSessionSeatPlan/i.test(r.url()) && r.request().method() === "POST",
            { timeout: 15000 }
        ).catch(() => null);

    let seatPlan = null;
    if (resp) {
        try { seatPlan = await resp.json(); } catch {}
    }

    // Fallback: count from DOM if the API didn’t return Areas
    let summary = null;
    if (seatPlan?.ResponseData?.Areas) {
        summary = summarizeSeatLayout(seatPlan);
    } else {
        const counts = await domFallbackCounts(page);
        if (counts.capacity > 0) {
            summary = { ...counts, statusBreakdown: undefined };
        }
    }

    if (!summary) {
        if (debug) {
            const cookies = await context.cookies();
            console.error("Seat plan fetch failed; cookies:", cookies.filter(c=>c.name.startsWith("Cine")).map(c=>({name:c.name,value:c.value.slice(0,6)+"…"})));
        }
        console.error(`Seat plan not accessible (sessionID=${picked.sessionID}).`);
        await browser.close();
        process.exit(5);
    }

    console.log(JSON.stringify({
        url,
        film: picked.title || null,
        filmCode: picked.film || null,
        sessionID: picked.sessionID,
        cinemaId: picked.cinemaId || null,
        date: picked.date || null,
        time: picked.time || null,
        capacity: summary.capacity,
        available: summary.available,
        sold: summary.sold,
        statusBreakdown: summary.statusBreakdown
    }));

    await browser.close();
})();
