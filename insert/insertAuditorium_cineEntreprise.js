import { chromium } from "playwright";
import minimist from "minimist";
import fs from "fs";
import path from "path";

/* ----------------- CLI ----------------- */
const args = minimist(process.argv.slice(2));
const { url, date, time, film, index, debug } = args;
if (!url) {
    console.error('Usage: node cineEntreprise_seats.playwright.mjs --url "<cinema-or-film-page-url>" [--date YYYY-MM-DD] [--time HH:MM] [--film HO0000..] [--index N] [--debug]');
    process.exit(1);
}

/* --------------- Helpers --------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toMDY = (iso) => {
    if (!iso) return null;
    const [Y, M, D] = iso.split("-").map(Number);
    return `${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}-${Y}`;
};
const fromMDY_HM = (mdy, hm) => {
    const [M, D, Y] = mdy.split("-").map(Number);
    const [h, m] = hm.split(":").map(Number);
    return new Date(Y, M - 1, D, h, m, 0, 0);
};

function summarizeSeatLayout(json) {
    const areas = json?.ResponseData?.Areas || [];
    let capacity = 0,
        available = 0,
        sold = 0;
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
                if (st === 0) available++;
                else sold++;
            }
        }
    }
    return { capacity, available, sold, statusBreakdown };
}

async function readButtons(page) {
    return await page.evaluate(() => {
        const parse = (el) => {
            const p = el.getAttribute("params") || "";
            const get = (re) => p.match(re)?.[1] ?? "";
            return {
                time: get(/html:\s*'([^']+)'/),
                date: get(/date:\s*'([^']+)'/),
                film: get(/currentFilm:\s*{[^}]*Value:\s*'([^']+)'/),
                title: get(/currentFilm:\s*{[^}]*Label:\s*'([^']+)'/),
                sessionID: get(/sessionID:\s*'([^']+)'/),
                cinemaId: get(/cinemaId:\s*'([^']+)'/),
            };
        };
        return [...document.querySelectorAll("add-ticket-modal-btn[params]")].map(parse);
    });
}

async function ensureButtonsOnPage(page, baseUrl) {
    for (let i = 0; i < 4; i++) {
        await page.evaluate((y) => window.scrollTo(0, (document.body.scrollHeight * (y + 1)) / 4), i);
        await sleep(200);
    }
    let has = await page.$("add-ticket-modal-btn[params]");
    if (!has && /\/horaires\b/i.test(baseUrl)) {
        const fallback = baseUrl.replace(/\/horaires\b/i, "");
        await page.goto(fallback, { waitUntil: "networkidle", timeout: 0 });
        for (let i = 0; i < 4; i++) {
            await page.evaluate((y) => window.scrollTo(0, (document.body.scrollHeight * (y + 1)) / 4), i);
            await sleep(200);
        }
        has = await page.$("add-ticket-modal-btn[params]");
    }
    return !!has;
}

async function acceptCookies(page) {
    const sels = [
        "#cookieyes-accept-btn",
        "#cky-btn-accept",
        "[data-cky-tag='accept-button']",
        "button:has-text('Accepter')",
        "button:has-text('J’accepte')",
    ];
    for (const sel of sels) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await btn.click().catch(() => {});
                break;
            }
        } catch {}
    }
}

async function triggerShowtime(page, sessionID) {
    const ok = await page.evaluate((sid) => {
        const nodes = [...document.querySelectorAll("add-ticket-modal-btn[params]")];
        for (const el of nodes) {
            const p = el.getAttribute("params") || "";
            if (!p.includes(`sessionID: '${sid}'`)) continue;
            try {
                if (window.ko) {
                    const vm = window.ko.dataFor(el);
                    if (vm && typeof vm.open === "function") {
                        vm.open();
                        return true;
                    }
                }
            } catch {}
            const btn = el.querySelector("button");
            if (btn) {
                btn.click();
                return true;
            }
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return true;
        }
        return false;
    }, sessionID);
    if (!ok) throw new Error("Could not trigger showtime");
}

/**
 * Adaptive flow:
 *  - Wait for either: modal OR /cart OR seat-map.
 *  - If modal, add 1 ticket, click "Ajouter au panier", click "Oui".
 *  - If already /cart or seat-map, return.
 */
async function advanceThroughTicketModal(page) {
    const outcome = await Promise.race([
        page
            .waitForSelector(".mfp-content, .modal, .add-ticket-modal", { timeout: 20000 })
            .then(() => "modal")
            .catch(() => null),
        page.waitForURL(/\/cart\b/i, { timeout: 20000 }).then(() => "cart").catch(() => null),
        page
            .waitForSelector(".seat-map__wrapper, .seat-map__container, [class*='seat-map']", { timeout: 20000 })
            .then(() => "seats")
            .catch(() => null),
    ]);

    if (outcome === "cart" || outcome === "seats") {
        return; // no modal step needed
    }

    // We’re in the modal – add 1 ticket
    const plus = page.locator(".std-number__plus, .qty__plus, .quantity__plus, button[aria-label='+']").first();
    await plus.waitFor({ state: "visible", timeout: 20000 });
    await plus.click();

    // Wait for the "Ajouter au panier" button to enable, then click it
    const addBtn =
        page.locator(".cart-validation__proceed-payment-button:enabled").first()
            .or(page.getByRole("button", { name: /ajouter au panier/i }).first());
    await addBtn.waitFor({ state: "visible", timeout: 20000 });
    await addBtn.click();

    // Confirm "Oui" if the confirmation dialog appears
    const ouiBtn = page.getByRole("button", { name: /^oui$/i }).first().or(page.locator("button.std-button:has-text('Oui')").first());
    try {
        await ouiBtn.waitFor({ state: "visible", timeout: 8000 });
        await ouiBtn.click();
    } catch {
        // no confirmation dialog – that's fine
    }

    // Seat map or /cart should load now
    await Promise.race([
        page.waitForSelector(".seat-map__wrapper, .seat-map__container, [class*='seat-map']", { timeout: 20000 }).catch(() => null),
        page.waitForURL(/\/cart\b/i, { timeout: 20000 }).catch(() => null),
        page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null),
    ]);
}

async function forceCart(page, sessionID, cinemaId) {
    const cartUrl = `https://www.cinentreprise.com/cart?sessionId=${encodeURIComponent(sessionID)}&cinemaId=${encodeURIComponent(
        cinemaId || ""
    )}`;
    await page.goto(cartUrl, { waitUntil: "networkidle", timeout: 0 });
    await page.waitForLoadState("networkidle");
}

async function domFallbackCounts(page) {
    return await page.evaluate(() => {
        const nodes = document.querySelectorAll(".seat-map__rows .seat-map__seat, .seat-map__seat--rowName");
        const classify = (el) => {
            const c = (el.className || "").toLowerCase();
            const title = (el.getAttribute("title") || "").toLowerCase();
            const text = (el.textContent || "").trim();
            const avail = /available|disponible/.test(c) || /disponible/.test(title);
            const sold = /occup[ée]|sold|pris/.test(c) || /occup|sold|pris/.test(title);
            const selected = /selected|choisi/.test(c) || /choisi/.test(title);
            const blocked = /social|distanc|blocked|bloqu/.test(c) || /distanc/.test(title);
            const wheelchair = /wheel|fauteuil/.test(c) || /fauteuil|wheel/.test(title);
            return { avail, sold, selected, blocked, wheelchair, text };
        };
        let capacity = 0,
            available = 0,
            sold = 0;
        for (const el of nodes) {
            const { avail, sold: sld, selected: sel, blocked: blk, wheelchair, text } = classify(el);
            const looksLikeSeat = /^\d+$/.test(text) || avail || sld || sel || blk || wheelchair;
            if (!looksLikeSeat) continue;
            capacity++;
            if (avail) available++;
            else sold++;
        }
        return { capacity, available, sold };
    });
}

/* ----------------- Main ---------------- */
(async () => {
    const outDir = "debug-artifacts";
    fs.mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 }, // ensure desktop layout
        locale: "fr-CA",
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        recordHar: { path: path.join(outDir, "network.har"), content: "embed" },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();

    // Log only /ticketingapi/* for debugging
    page.on("request", (req) => {
        if (/\/ticketingapi\//i.test(req.url())) {
            fs.appendFileSync(path.join(outDir, "network.log"), `>>> ${req.method()} ${req.url()}\n${req.postData() || ""}\n\n`);
        }
    });
    page.on("response", async (res) => {
        if (/\/ticketingapi\//i.test(res.url())) {
            let t = "";
            try {
                t = await res.text();
            } catch {}
            fs.appendFileSync(path.join(outDir, "network.log"), `<<< ${res.status()} ${res.request().method()} ${res.url()}\n${t.slice(0, 4000)}\n\n`);
        }
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 0 });
    await acceptCookies(page);

    if (!(await ensureButtonsOnPage(page, url))) {
        console.error("No showtime buttons found on the page.");
        await context.tracing.stop({ path: path.join(outDir, "trace.zip") });
        await browser.close();
        process.exit(2);
    }

    const all = await readButtons(page);

    const wantMDY = date ? toMDY(date) : null;
    const wantTime = time || null;
    const wantFilm = film || null;

    let candidates = all.filter((x) => x.sessionID);
    if (wantFilm) candidates = candidates.filter((x) => x.film === wantFilm);
    if (wantMDY) candidates = candidates.filter((x) => x.date === wantMDY);
    if (wantTime) candidates = candidates.filter((x) => x.time === wantTime);
    if (!candidates.length) candidates = all;

    let picked;
    if (index != null) {
        picked = candidates[Number(index)] || null;
    } else {
        const now = new Date();
        const scored = candidates.map((x) => ({
            x,
            dt: x.date && x.time ? fromMDY_HM(x.date, x.time) : new Date(8640000000000000),
        }));
        const fut = scored.filter((s) => s.dt > now).sort((a, b) => a.dt - b.dt);
        picked = fut[0]?.x || scored.sort((a, b) => a.dt - b.dt)[0]?.x || null;
    }
    if (!picked) {
        console.error("Could not choose a session from this URL.");
        await context.tracing.stop({ path: path.join(outDir, "trace.zip") });
        await browser.close();
        process.exit(3);
    }
    if (debug) console.error("Picked:", picked);

    // Catch the seat-plan XHR while we interact
    const seatPlanPromise = page
        .waitForResponse((r) => /ticketingapi\/GetSessionSeatPlan/i.test(r.url()) && r.request().method() === "POST", {
            timeout: 30000,
        })
        .catch(() => null);

    await triggerShowtime(page, picked.sessionID);
    try {
        await advanceThroughTicketModal(page);
    } catch {
        // If the adaptive step still didn't find anything, jump to /cart directly
        await forceCart(page, picked.sessionID, picked.cinemaId);
    }

    // Race outcome → get the response or wait a bit more
    const raced = await Promise.race([
        seatPlanPromise,
        page.waitForResponse((r) => /ticketingapi\/GetSessionSeatPlan/i.test(r.url()) && r.request().method() === "POST", { timeout: 15000 }).catch(() => null),
    ]);

    let seatPlan = null;
    if (raced && typeof raced.json === "function") {
        try {
            seatPlan = await raced.json();
        } catch {}
    }

    // Fallback: count from DOM if API didn’t give Areas
    let summary = null;
    if (seatPlan?.ResponseData?.Areas) {
        summary = summarizeSeatLayout(seatPlan);
    } else {
        const counts = await domFallbackCounts(page);
        if (counts.capacity > 0) summary = { ...counts, statusBreakdown: undefined };
    }

    if (!summary) {
        if (debug) {
            const cookies = await context.cookies();
            console.error(
                "Seat plan fetch failed; cookies:",
                cookies.filter((c) => c.name.startsWith("Cine")).map((c) => ({ name: c.name, value: c.value.slice(0, 6) + "…" }))
            );
        }
        console.error(`Seat plan not accessible (sessionID=${picked.sessionID}).`);
        await context.tracing.stop({ path: path.join(outDir, "trace.zip") });
        await browser.close();
        process.exit(5);
    }

    console.log(
        JSON.stringify({
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
            statusBreakdown: summary.statusBreakdown,
        })
    );

    await context.tracing.stop({ path: path.join(outDir, "trace.zip") });
    await browser.close();
})().catch(async (e) => {
    console.error("Fatal:", e?.message || e);
    process.exit(10);
});
