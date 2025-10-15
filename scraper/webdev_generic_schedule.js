// scraper/schedule_generic_noseats.js
import fetch from "node-fetch";
import http from "node:http";
import https from "node:https";
import { parse } from "node-html-parser";
import fs from "fs";

// --- low-level http
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 1 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const AGENT = (url) => url.startsWith("https:") ? httpsAgent : httpAgent;

// --- time utils
const pad2 = (n) => String(n).padStart(2, "0");
const TIME_RE = new RegExp(
    String.raw`\b(?:` +
    String.raw`(?:[01]?\d|2[0-3]):[0-5]\d|` +
    String.raw`(?:[01]?\d|2[0-3])\s*h\s*(?:[0-5]\d)?|` +
    String.raw`(?:1[0-2]|0?\d):[0-5]\d\s*(?:AM|PM)` + `)\\b`,
    "i"
);
function pickTimeFromText(s) {
    if (!s) return null;
    const m = s.match(TIME_RE);
    if (!m) return null;
    const t = m[0].replace(/\s+/g, " ").trim();
    const h = t.match(/^([01]?\d|2[0-3])\s*h\s*([0-5]\d)?$/i);
    if (h) return `${String(h[1]).padStart(2,"0")}:${(h[2]?h[2]:"00")}`;
    const m24 = t.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (m24) return `${m24[1].padStart(2,"0")}:${m24[2]}`;
    const m12 = t.match(/^(1[0-2]|0?\d):([0-5]\d)\s*(AM|PM)$/i);
    if (m12) {
        let H = Number(m12[1]), M = m12[2], ap = m12[3].toUpperCase();
        if (ap==="PM" && H!==12) H+=12;
        if (ap==="AM" && H===12) H=0;
        return `${String(H).padStart(2,"0")}:${M}`;
    }
    return t;
}

// --- title cleaner (same as your helpers, condensed)
function cleanText(s=""){ return s.replace(/\u00A0/g," ").replace(/\s*[–—\-|•·:,/]\s*$/g,"").replace(/\s{2,}/g," ").trim(); }
function sanitizeTitle(raw=""){ return cleanText(raw); }

// --- defaults for selector profiles (works for RGFM; Azur extends it)
const DEFAULT_SELECTORS = {
    discoverRows: (doc) => {
        const rows = new Set();
        for (const el of doc.querySelectorAll('[id^="zrl_"]')) {
            const m = el.id.match(/^zrl_(\d+)_A\d+$/);
            if (m) rows.add(m[1]);
        }
        return [...rows];
    },
    titleCandidates: (row) => [
        `#zrl_${row}_A37`, `#zrl_${row}_A35`, `[id^="zrl_${row}_A"]`
    ],
    buttonSelectors: (row) => [
        `a[id^="c-${row}-A"]`,        // RGFM style
        `a[id^="zrl_${row}_A"]`,      // Azur style
        `[id^="c-${row}-A"][role="button"]`,
        `[role="button"][id^="c-${row}-A"]`,
        `[id^="zrl_${row}_A"][role="button"]`,
        `[role="button"][id^="zrl_${row}_A"]`,
    ],
    hiddenKeySelectors: (row, a) => [
        `#zrl_${row}_A${a}`,          // RGFM hidden P3s
        `#tzzrl_${row}_A${a}`,        // Azur hidden P3s
        `#tzrl_${row}_A${a}`,         // rare variant
    ],
    hiddenScanRange: [2, 200],      // scan broad A2..A200
};

function textOf(node){ return (node?.text || node?.innerText || "").trim(); }

function extractTitle(doc, row, selectors){
    for (const css of (selectors.titleCandidates(row) || [])) {
        const el = doc.querySelector(css);
        const txt = cleanText(textOf(el));
        if (txt) return sanitizeTitle(txt);
    }
    return null;
}

function extractButtons(doc, row, selectors){
    const out = [];
    for (const sel of (selectors.buttonSelectors(row) || [])) {
        for (const a of doc.querySelectorAll(sel)) {
            const t = textOf(a);
            if (!TIME_RE.test(t)) continue;
            const href = a.getAttribute?.("href") || null;
            const p3 = href && (href.match(/[?&]P3=(\d+)/i) || [])[1];
            out.push({ time: pickTimeFromText(t), p3: p3 || null });
        }
    }
    return out;
}

function extractHiddenKeys(doc, row, selectors){
    const [lo, hi] = selectors.hiddenScanRange || [2, 200];
    const keys = [];
    for (let a = lo; a <= hi; a++) {
        for (const css of (selectors.hiddenKeySelectors(row, a) || [])) {
            const el = doc.querySelector(css);
            const v = textOf(el);
            if (/^\d{5,}$/.test(v)) keys.push(v);
        }
    }
    return keys;
}

function mergeButtonsWithKeys(buttons, keys){
    const out = []; let k = 0;
    for (const b of buttons) {
        out.push({ time: b.time, p3: b.p3 || (k < keys.length ? keys[k++] : null) });
    }
    return out;
}

function synthUrl(purchaseUrl, p1, p2, p3){
    if (!p3) return null;
    const u = new URL(purchaseUrl);
    u.searchParams.set("P1", p1 || "01");
    u.searchParams.set("P2", p2 || "01");
    u.searchParams.set("P3", p3);
    return u.toString();
}

// --- date flow helpers
function getP1P2FromHoraire(horaireUrl){
    try {
        const u = new URL(horaireUrl);
        return { P1: u.searchParams.get("P1") || "01", P2: u.searchParams.get("P2") || "01" };
    } catch { return { P1: "01", P2: "01" }; }
}
function toWebdevDateParts(iso){
    const [Y,M,D] = iso.split("-").map(Number);
    return { jour: `${Y}${pad2(M)}${pad2(D)}`, mois: `${Y}${pad2(M)}01` };
}
const COMMON_HEADERS = (base, referer) => ({
    "accept": "*/*",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7,fr-CA;q=0.6",
    "cache-control": "no-cache",
    "content-type": "application/x-www-form-urlencoded",
    "pragma": "no-cache",
    "sec-ch-ua": "\"Google Chrome\";v=\"141\", \"Not?A_Brand\";v=\"8\", \"Chromium\";v=\"141\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "origin": base,
    "referer": referer,
});
async function primingGet(horaireUrl){
    const r = await fetch(horaireUrl, { redirect: "follow", agent: AGENT(horaireUrl) });
    const set = r.headers.raw()["set-cookie"] || [];
    set.push("wbNavigateurLargeur=1200; Path=/");
    return set.map(s => s.split(";")[0]).join("; ");
}
async function openCalendar(horaireUrl, cookie, base){
    const body = new URLSearchParams();
    body.set("WD_ACTION_", "AJAXPAGE");
    body.set("EXECUTE", "16");
    body.set("WD_CONTEXTE_", "A15");
    body.set("WD_JSON_PROPRIETE_", "");
    body.set("WD_BUTTON_CLICK_", "");
    body.set("A8", "1");
    body.set("A8_DEB", "1");
    body.set("_A8_OCC", "11");
    body.set("A6_JOUR", "");
    body.set("A6_MOIS", "");
    await fetch(horaireUrl, {
        method: "POST",
        headers: { ...COMMON_HEADERS(base, horaireUrl), Cookie: cookie },
        body, redirect: "manual", agent: AGENT(horaireUrl)
    }).then(r=>r.text());
}
async function setDayAndGetFragment(horaireUrl, cookie, base, jour, mois, dumpPath){
    const body = new URLSearchParams();
    body.set("WD_ACTION_", "AJAXCHAMP");
    body.set("ACTIONCHAMP", "");
    body.set("WD_CONTEXTE_", "A6");
    body.set("A6_JOUR", jour);
    body.set("A6_MOIS", mois);
    const r = await fetch(horaireUrl, {
        method: "POST",
        headers: { ...COMMON_HEADERS(base, horaireUrl), "x-requested-with": "XMLHttpRequest", Cookie: cookie },
        body, redirect: "manual", agent: AGENT(horaireUrl)
    });
    const txt = await r.text();
    if (dumpPath) fs.writeFileSync(dumpPath, txt);
    return txt;
}
async function fetchUpdatedSchedule(horaireUrl, cookie, base, dumpPath){
    const r = await fetch(horaireUrl, {
        method: "GET",
        headers: { ...COMMON_HEADERS(base, horaireUrl), "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Cookie: cookie },
        redirect: "follow",
        agent: AGENT(horaireUrl)
    });
    const html = await r.text();
    if (dumpPath) fs.writeFileSync(dumpPath, html);
    return html;
}
// In your createGenericNoSeatsProvider module:

// Small helper: extract P3 if you want to store it
function p3FromUrl(u) { try { return new URL(u).searchParams.get("P3"); } catch { return null; } }

// Build the RGFM-style form body for a given quantity q
// NOTE: This matches your working test/probe script (zrl_1_A23 = q+1 etc.)
function buildProbeBodyRGFM({ q, email, name }) {
    const WD_JSON = {
        m_oProprietesSecurisees: {},
        m_oChampsModifies: { A9: true },
        m_oVariablesProjet: {},
        m_oVariablesPage: {}
    };
    const p = new URLSearchParams();
    p.set("WD_JSON_PROPRIETE_", JSON.stringify(WD_JSON));
    p.set("WD_BUTTON_CLICK_", "A12");
    p.set("WD_ACTION_", "");

    // Ticket selector block
    p.set("A13", "1");
    p.set("A13_DEB", "1");
    p.set("_A13_OCC", "4");

    // Quantities (MAIN = q+1; companions fixed as 1)
    p.set("zrl_1_A23", String(q + 1));
    p.set("zrl_2_A23", "1");
    p.set("zrl_3_A23", "1");
    p.set("zrl_4_A23", "1");

    // Companions blank
    p.set("zrl_1_A35", "");
    p.set("zrl_2_A35", "");
    p.set("zrl_3_A35", "");
    p.set("zrl_4_A35", "");

    // Identity/contact (required fields)
    p.set("A9",  email);
    p.set("A10", email);
    p.set("A62", name);

    // Misc empties seen in the wild
    for (const k of ["A58","A54","A39","A43","A46","A48","A52","A50","A51"]) p.set(k, "");
    return p;
}

// One attempt: POST to purchase URL, see if we get confirmation redirect
async function tryProbePurchase({ showUrl, cookie, q, origin }) {
    const hdr = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": origin,
        "Referer": showUrl,
        "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.8",
        "Cookie": cookie,
        "Connection": "keep-alive",
    };
    const res = await fetch(showUrl, {
        method: "POST",
        headers: hdr,
        body: buildProbeBodyRGFM({ q, email: process.env.PROBE_EMAIL || "probe@example.com", name: process.env.PROBE_NAME || "Probe" }),
        redirect: "manual",
        agent: AGENT(showUrl)
    });
    const loc = res.headers.get("location") || "";
    const ok  = res.status >= 300 && res.status < 400 && /vente-confirmation\.awp/i.test(loc);
    return { ok, status: res.status, location: loc, confirmUrl: ok ? new URL(loc, showUrl).toString() : null };
}

// Priming GET specifically for the purchase page (to get cookies for that host/path)
async function primingPurchaseGet(showUrl) {
    const r = await fetch(showUrl, { redirect: "follow", agent: AGENT(showUrl) });
    const set = r.headers.raw()["set-cookie"] || [];
    // viewport cookie helps some themes choose page layout
    set.push("wbNavigateurLargeur=803; Path=/");
    return set.map(s => s.split(";")[0]).join("; ");
}

async function probeCandidateOnce({ showUrl, candidate, origin, cookie }) {
    if (!Number.isFinite(candidate) || candidate <= 0) {
        throw new Error(`invalid candidate: ${candidate}`);
    }
    const q = candidate - 1; // server sees quantity = q+1
    const effCookie = cookie || await primingPurchaseGet(showUrl);
    const { ok, status, location, confirmUrl } =
        await tryProbePurchase({ showUrl, cookie: effCookie, q, origin });
    return { ok, meta: { status, location, confirmUrl, qSent: q, candidate, cookie: effCookie } };
}

async function makePurchaseSession(showUrl) {
    const cookie = await primingPurchaseGet(showUrl);
    return { cookie };
}

// === MAIN FACTORY (only getSeats shown here; keep your existing getSchedule) ===
export function createGenericNoSeatsProvider({
                                                 HORAIRE_URL,
                                                 PURCHASE_URL,
                                                 BASE,
                                                 selectors = {},
                                                 hooks = {},
                                                 // Optional probe tuning (override per site if needed)
                                                 probe = {
                                                     startHigh: 300,    // where to start the descending probe
                                                     minQ: 1,           // stop floor
                                                     cooldownMs: 0,     // delay between attempts, if you want to be gentle
                                                 }
                                             }) {
    const sel  = { ...DEFAULT_SELECTORS, ...selectors };
    const base = BASE || new URL(HORAIRE_URL).origin;
    const { P1, P2 } = getP1P2FromHoraire(HORAIRE_URL);

    return {
        kind: "noseats",

        async getSchedule({ dateISO, dump=false }) {
            const { jour, mois } = toWebdevDateParts(dateISO);
            const cookie = await primingGet(HORAIRE_URL);
            await openCalendar(HORAIRE_URL, cookie, base);

            const fragment = await setDayAndGetFragment(
                HORAIRE_URL, cookie, base, jour, mois, dump ? "webdev_fragment.html" : ""
            );

            let doc  = parse(fragment.replace(/&amp;/g,"&"));
            let rows = sel.discoverRows(doc);

            if (!rows.length) {
                const fullHtml = await fetchUpdatedSchedule(
                    HORAIRE_URL, cookie, base, dump ? "webdev_full.html" : ""
                );
                doc  = parse(fullHtml.replace(/&amp;/g,"&"));
                rows = sel.discoverRows(doc);
            }

            const items = [];
            for (const row of rows) {
                const rawTitle = extractTitle(doc, row, sel);
                const title    = sanitizeTitle(hooks.postCleanTitle ? hooks.postCleanTitle(rawTitle) : rawTitle);
                const btns     = extractButtons(doc, row, sel);
                if (!btns.length) continue;
                const keys     = extractHiddenKeys(doc, row, sel);
                const paired   = mergeButtonsWithKeys(btns, keys);
                for (const it of paired) {
                    if (!it.time && !it.p3) continue;
                    items.push({
                        row,
                        title: title || null,
                        time:  it.time || null,
                        p3:    it.p3   || null,
                        url:   synthUrl(PURCHASE_URL, P1, P2, it.p3),
                    });
                }
            }

            const m = new Map();
            for (const s of items) m.set(`${s.row}|${s.time||""}|${s.p3||""}`, s);
            return [...m.values()].sort((a,b)=>(a.time||"").localeCompare(b.time||""));
        },

        async getSeats({
                           dateISO,
                           hhmm,
                           title,
                           showUrl,
                           dump = false,
                           expectedCapacity,      // OPTIONAL: if caller knows capacity (from screen_id->seat_count), pass it
                           probeOverride          // OPTIONAL: { startHigh, minQ, cooldownMs }
                       }) {
            if (!showUrl) {
                const err = new Error("showUrl is required for nonDisplayingSeats providers");
                err.code = "SHOW_URL_REQUIRED";
                throw err;
            }

            // --- Effective probe params (defaults < provider config < per-call override) ---
            const eff = {
                startHigh:
                    (typeof expectedCapacity === "number" && expectedCapacity > 0
                        ? Math.max(1, Math.min(800, expectedCapacity - 1)) // start just below capacity hint
                        : (probe?.startHigh ?? 300)),
                minQ:       probe?.minQ ?? 1,
                cooldownMs: probe?.cooldownMs ?? 0,
                ...(probeOverride || {}),
            };

            // 1) prime cookies for this show
            const cookie = await primingPurchaseGet(showUrl);

            // 2) linear descending probe from eff.startHigh → eff.minQ
            let successQ = null;
            let successUrl = null;

            for (let q = eff.startHigh; q >= eff.minQ; q--) {
                // try to reserve (q+1) tickets; success means remaining >= (q+1)
                const { ok, confirmUrl } = await tryProbePurchase({ showUrl, cookie, q, origin: base });
                if (ok) {
                    successQ = q;                // (q+1) was accepted
                    successUrl = confirmUrl || null;
                    break;                       // keep linear behavior: first success from the top
                }
                if (eff.cooldownMs > 0) {
                    await new Promise(r => setTimeout(r, eff.cooldownMs));
                }
            }

            // Fallback behavior requested:
            // If webdev no-seats provider would have returned 0 remaining (probe failure),
            // act as if exactly 1 ticket has been sold from seats_max:
            // seats_max = expectedCapacity (if given) else (eff.startHigh + 1).
            if (successQ == null) {
                const seatsMax = (typeof expectedCapacity === "number" && expectedCapacity > 0)
                    ? expectedCapacity
                    : (eff.startHigh + 1);
                const seatsRemainingFallback = Math.max(0, seatsMax - 1);
                return {
                    auditorium:      null,
                    seats_remaining: seatsRemainingFallback,
                    sellable:        null,
                    source:          "webdev",
                    url:             showUrl,
                    p3:              p3FromUrl(showUrl),
                    raw: {
                        reason: "fallback_one_sold_on_probe_failure",
                        dateISO, hhmm, title,
                        seats_max: seatsMax,
                        computed_fallback_seats_remaining: seatsRemainingFallback,
                        probed_from: eff.startHigh,
                        minQ: eff.minQ
                    }
                };
            }

            const seatsRemaining = successQ + 1;   // keep your established convention

            return {
                auditorium:      null,
                seats_remaining: seatsRemaining,
                sellable:        null,
                source:          "webdev",
                url:             showUrl,
                p3:              p3FromUrl(showUrl),
                raw: {
                    confirm_url: successUrl,
                    probed_from: eff.startHigh,
                    found_q:     successQ,
                    computed_seats_remaining: seatsRemaining,
                    dateISO, hhmm, title
                }
            };
        },

        // NEW: single-candidate probe (no loop inside)
        async probeCapacityCandidate({ showUrl }, candidate, { session } = {}) {
            if (!showUrl) {
                const err = new Error("showUrl is required for probeCapacityCandidate");
                err.code = "SHOW_URL_REQUIRED";
                throw err;
            }
            const { cookie } = session || {};
            return await probeCandidateOnce({ showUrl, candidate, origin: base, cookie });
        },

        // NEW: create a reusable cookie/session for multiple probes on the same show
        async createPurchaseSession({ showUrl }) {
            if (!showUrl) {
                const err = new Error("showUrl is required for createPurchaseSession");
                err.code = "SHOW_URL_REQUIRED";
                throw err;
            }
            const cookie = await primingPurchaseGet(showUrl);
            return { cookie };
        },
    };
}
