// test/rgfm_fetch_schedule.js
import fetch from "node-fetch";
import http from "node:http";
import https from "node:https";
import { parse } from "node-html-parser";
// Optional: turn on to dump the raw bodies once
const DUMP_BODIES = false;
import fs from "fs";
import pLimit from "p-limit";

const BASE = "https://billetterie.cinemasrgfm.com";
const HORAIRE_URL = process.env.HORAIRE_URL ||
    `${BASE}/FR/horaire.awp?P1=01&P2=03&P3=`;

const TARGET_DATE = process.env.TARGET_DATE || "2025-10-15"; // YYYY-MM-DD

const COMMON_HEADERS = {
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
    "referer": HORAIRE_URL,
    "origin": "https://billetterie.cinemasrgfm.com", // <- IMPORTANT
};

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 1 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const AGENT = (url) => url.startsWith("https:") ? httpsAgent : httpAgent;

const joinCookies = (arr) => arr.map(s => s.split(";")[0]).join("; ");
const pad2 = (n) => String(n).padStart(2, "0");

// ---- robust time/title helpers ----

// French + 24h + 12h patterns
const TIME_RE = new RegExp(
    String.raw`\b(?:` +
    // 24h "13:20" / "9:05"
    String.raw`(?:[01]?\d|2[0-3]):[0-5]\d` + `|` +
    // "13h20", "13 h 20", "13 h"
    String.raw`(?:[01]?\d|2[0-3])\s*h\s*(?:[0-5]\d)?` + `|` +
    // 12h "1:20 PM"
    String.raw`(?:1[0-2]|0?\d):[0-5]\d\s*(?:AM|PM|am|pm)` +
    `)\b`,
    "g"
);

// helper: GET a Film-achat page and extract title + time
async function fetchTitleTimeFromFilmAchat(url, agent) {
    const r = await fetch(url, {
        method: "GET",
        headers: {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": COMMON_HEADERS["accept-language"],
            "cache-control": "no-cache",
            "pragma": "no-cache",
            "referer": HORAIRE_URL,
        },
        redirect: "follow",
        agent: AGENT(url)
    });
    const html = await r.text();

    // Primary: exact IDs seen on RGFM pages
    //  - title: #tzA2
    //  - datetime: #tzA8 => "... - HH:MM"
    let m;

    // cheap string search first (fast, no DOM yet)
    const titleId = 'id="tzA2"';
    const timeId  = 'id="tzA8"';

    // extract innerText-ish by stripping tags in a small window
    const pullTextNear = (hay, idx) => {
        const start = Math.max(0, idx - 300);    // plenty for a short <td>
        const end   = Math.min(hay.length, idx + 600);
        const frag  = hay.slice(start, end);
        return frag.replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    };

    let title = null;
    let when  = null;

    const iTitle = html.indexOf(titleId);
    if (iTitle !== -1) {
        const blob = pullTextNear(html, iTitle);
        // title is usually the whole cell text, keep it clean
        title = blob;
        // tighten common noise if any
        title = title.replace(/^.*?\b(?:tzA2|Titre|Titre\s*:)\b\s*/i, "").trim();
        // if it still looks too long, fallback to DOM parser
        if (title.length > 180) title = null;
    }

    const iTime = html.indexOf(timeId);
    if (iTime !== -1) {
        const blob = pullTextNear(html, iTime);
        // Expect "... - HH:MM" or "HHhMM"
        m = blob.match(/\b([01]?\d|2[0-3]):[0-5]\d\b|(?:[01]?\d|2[0-3])\s*h\s*[0-5]\d\b/);
        if (m) {
            const t = m[0].replace(/\s*h\s*/i, ":");
            const parts = t.split(":");
            when = `${parts[0].padStart(2,"0")}:${(parts[1]||"00").padStart(2,"0")}`;
        }
    }

    // DOM fallback if needed (rare)
    if (!title || !when) {
        const doc = parse(html);
        if (!title) {
            const tNode = doc.querySelector("#tzA2");
            if (tNode) title = tNode.text.trim();
        }
        if (!when) {
            const dNode = doc.querySelector("#tzA8");
            if (dNode) {
                const txt = dNode.text.trim();
                const mm = txt.match(/\b([01]?\d|2[0-3]):[0-5]\d\b|(?:[01]?\d|2[0-3])\s*h\s*[0-5]\d\b/);
                if (mm) {
                    const t = mm[0].replace(/\s*h\s*/i, ":");
                    const parts = t.split(":");
                    when = `${parts[0].padStart(2,"0")}:${(parts[1]||"00").padStart(2,"0")}`;
                }
            }
        }
    }

    const cleanTitle = title ? sanitizeTitle(title, when) : null;
    return {
        title: cleanTitle,
        time: when || null
    };

}

// after you compute `showings` from the schedule page:
async function enrichMissingFromPages(showings) {
    // only fetch pages for items missing title or time
    const needs = showings
        .map((s, idx) => ({...s, __idx: idx}))
        .filter(s => !s.title || !s.time);

    if (needs.length === 0) return showings;

    // cap concurrency to be polite & fast
    const limit = pLimit(4);

    await Promise.all(needs.map(item => limit(async () => {
        try {
            const { title, time } = await fetchTitleTimeFromFilmAchat(item.url);
            if (title) showings[item.__idx].title = title;
            if (time)  showings[item.__idx].time  = time;
        } catch (e) {
            // swallow; keep the original item
        }
    })));

    return showings;
}

function cleanText(s = "") {
    return s
        .replace(/\s*[–—\-|•·]\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function sanitizeTitle(rawTitle, maybeTime) {
    // if you also remove embedded time tokens:
    if (maybeTime) {
        const esc = maybeTime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        rawTitle = rawTitle.replace(new RegExp(`\\s*${esc}\\s*`), " ");
    }
    const { title } = extractVersionTag(rawTitle || "");
    return title;
}


function pickTimeFromText(s) {
    if (!s) return null;
    const m = s.match(TIME_RE);
    if (!m) return null;
    // normalize "13 h 05" → "13:05", "13h" → "13:00"
    const t = m[0].replace(/\s+/g, " ").trim();
    const h = t.match(/^([01]?\d|2[0-3])\s*h\s*([0-5]\d)?$/i);
    if (h) {
        const H = String(h[1]).padStart(2, "0");
        const M = h[2] ? String(h[2]).padStart(2, "0") : "00";
        return `${H}:${M}`;
    }
    const m24 = t.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (m24) return `${m24[1].padStart(2, "0")}:${m24[2]}`;
    const m12 = t.match(/^(1[0-2]|0?\d):([0-5]\d)\s*(AM|PM)$/i);
    if (m12) {
        let H = Number(m12[1]);
        const M = m12[2];
        const ap = m12[3].toUpperCase();
        if (ap === "PM" && H !== 12) H += 12;
        if (ap === "AM" && H === 12) H = 0;
        return `${String(H).padStart(2, "0")}:${M}`;
    }
    return t;
}

function stripTimeFromTitle(title, time) {
    if (!title || !time) return cleanText(title || "");
    const esc = time.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return cleanText(title.replace(new RegExp(`\\s*${esc}\\s*`), " "));
}

// Robust version/format tag stripper for FR cinema titles (no /x flag)
function extractVersionTag(s = "") {
    if (!s) return { title: "", version: null };

    // Normalize NBSP -> space for safer matching
    let src = s.replace(/\u00A0/g, " ");

    // Build a consolidated tag pattern (case-insensitive, unicode)
    const tagAlts = [
        // Language/subs variants
        "V\\.?\\s*O\\.?A?",         // V.O., V.O.A, VOA
        "V\\.?\\s*F\\.?",           // V.F., VF
        "VO(?:ST|STFR|A)?",         // VO, VOST, VOSTFR, VOA
        "VF(?:ST)?",                // VF, VFST
        "VOSTFR",
        "VO-?ENG", "VO-?FR", "ENG\\s*SUBS",

        // Formats
        "3[\\-\\s]?D",              // 3D, 3-D
        "2[\\-\\s]?D",              // 2D, 2-D
        "IMAX",
        "LASER",
        "HFR",
        "4K",
        "D[\\-\\s]?BOX",            // DBOX, D-BOX
        "4DX",
        "ULTRA\\s*AVX",
        "SCREENX",
        "ATMOS",
        "DOLBY\\s+ATMOS",

        // Very generic FR/ENG: only strip when standalone, not in words
        "FR",
        "ENG"
    ];
    const TAG_RE = new RegExp(`\\b(?:${tagAlts.join("|")})\\b`, "giu");

    // 1) Strip trailing bracketed blocks that contain any known tags — do this repeatedly
    //    e.g., "Titre (VO 3D)" -> "Titre"
    const bracketTail = /[\(\[\{][^)\]}]*?(?:VO|VF|3D|2D|ATMOS|IMAX|DBOX|D-?BOX|VOSTFR|ENG|FR)[^)\]}]*[\)\]\}]\s*$/i;
    while (bracketTail.test(src)) {
        src = src.replace(bracketTail, "").trim();
    }

    // 2) Remove loose tags at the very end, with optional separators — repeat until none
    //    e.g., "Titre - VO 3D" -> "Titre"
    const sep = String.raw`(?:[-–—|:,/]\s*)?`; // common separators
    const tailTag = new RegExp(`${sep}${TAG_RE.source}\\s*$`, "iu");
    while (tailTag.test(src)) {
        src = src.replace(tailTag, "").trim();
    }

    // 3) Collect tags (anywhere in the string) before removing them — for the "version" field
    const found = src.match(TAG_RE) || s.match(TAG_RE) || [];
    const version = found.length
        ? [...new Set(found.map(v => v.toUpperCase()))].join(" ")
        : null;

    // 4) Remove remaining tags anywhere in the string (rare, just in case)
    src = src.replace(TAG_RE, " ").trim();

    // 5) Clean up duplicate spaces and trailing separators
    src = src
        .replace(/\s*[–—\-|•·:,/]\s*$/g, "") // trailing punctuation
        .replace(/\s{2,}/g, " ")
        .trim();

    return { title: src, version };
}



// Extract P1/P2 from the horaire URL so we can synthesize links if needed
function getP1P2() {
    try {
        const u = new URL(HORAIRE_URL);
        const P1 = u.searchParams.get("P1") || "01";
        const P2 = u.searchParams.get("P2") || "01";
        return { P1, P2 };
    } catch {
        return { P1: "01", P2: "01" };
    }
}
const { P1, P2 } = getP1P2();

// Convert "YYYY-MM-DD" → { jour: "YYYYMMDD", mois: "YYYYMM01" }
function toWebdevDateParts(iso) {
    const [Y, M, D] = iso.split("-").map(Number);
    const jour = `${Y}${pad2(M)}${pad2(D)}`;
    const mois = `${Y}${pad2(M)}01`;
    return { jour, mois };
}

async function primingGet() {
    const r = await fetch(HORAIRE_URL, { redirect: "follow", agent: AGENT(HORAIRE_URL) });
    const set = r.headers.raw()["set-cookie"] || [];
    set.push("wbNavigateurLargeur=1200; Path=/");
    return joinCookies(set);
}

// 1) Open calendar overlay
async function openCalendar(cookie) {
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

    const r = await fetch(HORAIRE_URL, {
        method: "POST",
        headers: { ...COMMON_HEADERS, Cookie: cookie },
        body,
        redirect: "manual",
        agent: AGENT(HORAIRE_URL)
    });
    await r.text();
}

// 2) Select the day (AJAX fragment)
async function setDayAndGetFragment(cookie, jourYYYYMMDD, moisYYYYMM01) {
    const body = new URLSearchParams();
    body.set("WD_ACTION_", "AJAXCHAMP");
    body.set("ACTIONCHAMP", "");
    body.set("WD_CONTEXTE_", "A6");
    body.set("A6_JOUR", jourYYYYMMDD);
    body.set("A6_MOIS", moisYYYYMM01);

    const r = await fetch(HORAIRE_URL, {
        method: "POST",
        headers: {
            ...COMMON_HEADERS,
            "x-requested-with": "XMLHttpRequest",
            Cookie: cookie
        },
        body,
        redirect: "manual",
        agent: AGENT(HORAIRE_URL)
    });

    const txt = await r.text();
    if (DUMP_BODIES) fs.writeFileSync("rgfm_fragment.html", txt);
    return txt;
}

// 3) Full page after setting the day (fallback)
async function fetchUpdatedSchedule(cookie) {
    const r = await fetch(HORAIRE_URL, {
        method: "GET",
        headers: {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": COMMON_HEADERS["accept-language"],
            "origin": "https://billetterie.cinemasrgfm.com",
            Cookie: cookie,
            "cache-control": "no-cache",
            pragma: "no-cache",
            referer: HORAIRE_URL
        },
        redirect: "follow",
        agent: AGENT(HORAIRE_URL)
    });
    const html = await r.text();
    if (DUMP_BODIES) fs.writeFileSync("rgfm_full.html", html);
    return html;
}

// --- Extractors ---

// A) Regex-first: find Film-achat links anywhere (href, JS, JSON, encoded)
function extractShowUrlsFromText(txt, base = BASE) {
    const hay = txt
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");

    const seen = new Set();
    const out = [];

    // 1) Plain/relative URLs
    const re1 = /(?:\/FR\/)?Film-achat\.awp\?[^"'<> )]+/gi;
    for (const m of hay.matchAll(re1)) {
        const rel = m[0].startsWith("/") ? m[0] : `/FR/${m[0]}`;
        const abs = new URL(rel, base).toString();
        const P3 = (abs.match(/[?&]P3=(\d+)/i) || [])[1];
        if (!P3 || seen.has(P3)) continue;
        seen.add(P3);
        out.push({ p3: P3, url: abs });
    }

    // 2) Percent-encoded URLs (…Film-achat.awp%3FP1%3Dxx%26P2%3Dyy%26P3%3D123…)
    const re2 = /Film-achat\.awp%3FP1%3D\d+%26P2%3D\d+%26P3%3D(\d+)/gi;
    for (const m of hay.matchAll(re2)) {
        const P3 = m[1];
        if (seen.has(P3)) continue;
        seen.add(P3);
        const abs = `${base}/FR/Film-achat.awp?P1=${P1}&P2=${P2}&P3=${P3}`;
        out.push({ p3: P3, url: abs });
    }

    return out;
}

// B) DOM fallback: if anchors exist, enrich with time/title
function enrichWithContext(html, items) {
    if (items.length === 0) return items;
    const normalized = html.replace(/&amp;/g, "&");
    const doc = parse(normalized);

    const titleByRow = {};
    for (const t of doc.querySelectorAll('[id^="zrl_"][id$="_A37"]')) {
        const m = t.getAttribute("id")?.match(/^zrl_(\d+)_A37$/);
        if (m) titleByRow[m[1]] = t.text.trim();
    }

    const btnsByRow = {};
    for (const a of doc.querySelectorAll('a[id^="c-"][id*="-A1"]')) {
        const id = a.getAttribute("id") || "";
        const m = id.match(/^c-(\d+)-A1(6|7|8)$/);
        if (!m) continue;
        const row = m[1];
        (btnsByRow[row] ||= []).push({
            href: a.getAttribute("href") || "",
            time: a.text.trim()
        });
    }

    for (const it of items) {
        const hidden = doc.querySelectorAll('div[id^="zrl_"][id$="_A45"]')
            .find(d => (d.text || "").trim() === it.p3);
        if (!hidden) continue;
        const row = (hidden.getAttribute("id").match(/^zrl_(\d+)_A45$/) || [])[1];
        if (!row) continue;
        it.title = titleByRow[row] || it.title || null;
        const matchBtn = (btnsByRow[row] || []).find(b => (b.href || "").includes(`P3=${it.p3}`));
        it.time = matchBtn?.time || it.time || null;
    }
    return items;
}

// C) Hidden P3 fallback: build URLs from zrl_*_A45 even if no anchors/JS URLs exist
function extractFromHiddenA45(html) {
    const out = [];
    const seen = new Set();
    const re = /id=["']zrl_(\d+)_A45["'][^>]*>(\d+)</gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const row = m[1];
        const p3 = m[2];
        if (seen.has(p3)) continue;
        seen.add(p3);
        const url = `${BASE}/FR/Film-achat.awp?P1=${P1}&P2=${P2}&P3=${p3}`;
        out.push({ p3, url, row });
    }
    return out;
}

(async () => {
    try {
        const cookie = await primingGet();
        const { jour, mois } = toWebdevDateParts(TARGET_DATE);

        await openCalendar(cookie);

        // AJAX fragment after setting the day
        const fragmentHtml = await setDayAndGetFragment(cookie, jour, mois);

        // Pass 1: regex links from fragment
        let showings = extractShowUrlsFromText(fragmentHtml, BASE);
        console.log(`[debug] fragment URLs: ${showings.length}`);

        // Pass 1b: enrich (if DOM contains titles/times)
        showings = enrichWithContext(fragmentHtml, showings);
        showings = await enrichMissingFromPages(showings);


        // Pass 2: fallback to full page
        if (showings.length === 0) {
            const fullHtml = await fetchUpdatedSchedule(cookie);
            showings = extractShowUrlsFromText(fullHtml, BASE);
            console.log(`[debug] full-page URLs: ${showings.length}`);
            showings = enrichWithContext(fullHtml, showings);

            // Pass 3: final fallback — hidden P3 nodes
            if (showings.length === 0) {
                const hidden = extractFromHiddenA45(fragmentHtml);
                console.log(`[debug] hidden A45 P3s (fragment): ${hidden.length}`);
                if (hidden.length === 0) {
                    const fullHtml2 = DUMP_BODIES ? fs.readFileSync("rgfm_full.html", "utf8") : await fetchUpdatedSchedule(cookie);
                    const hiddenFull = extractFromHiddenA45(fullHtml2);
                    console.log(`[debug] hidden A45 P3s (full page): ${hiddenFull.length}`);
                    showings = hiddenFull;
                } else {
                    showings = hidden;
                }
            }
        }

        console.log(`Date: ${TARGET_DATE}`);
        console.log(`Found ${showings.length} showings:`);
        for (const s of showings) {
            const t = s.time || "??:??";
            const title = s.title || "(title n/a)";
            console.log(`- ${t} | ${title} -> ${s.url}`);
        }

        if (showings.length === 0 && !DUMP_BODIES) {
            console.error("[hint] Still 0. Set DUMP_BODIES=true to write rgfm_fragment.html / rgfm_full.html for inspection.");
        }
    } catch (err) {
        console.error("RGFM schedule fetch failed:", err);
        process.exitCode = 1;
    }
})();
