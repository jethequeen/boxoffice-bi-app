/* Generic WebDev (PC Soft) ticketing scraper core.
   Build per-provider instances with makeWebDevProvider({
     HORAIRE_URL, PURCHASE_URL,
     markerPattern?,           // default: /id="zrl_(\d+)_A9"/g
     styleAnchors?,            // e.g., ['margin-bottom:-1px']
     locateExpand? ,           // 'row' | 'table' (default 'table')
     hooks?: { locateBlock?, postCleanTitle? }
   })
*/

/* ------------------------------- small utils ------------------------------- */
function decodeEntities(s = "") {
    return s
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
function normTitle(s = "") {
    return decodeEntities(s)
        .replace(/\u2019/g, "'")
        .normalize("NFD").replace(/\p{Diacritic}/gu, "")
        .toLowerCase().replace(/\s+/g, " ").trim();
}
function hhmmFlexible(s = "") {
    // 18:45 / 18h45 → 18:45
    let m = String(s).match(/\b(\d{1,2})[:hH](\d{2})\b/);
    if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
    // bare hour "18" → 18:00 (nice-to-have)
    m = String(s).match(/\b(\d{1,2})\b/);
    return m ? `${m[1].padStart(2, "0")}:00` : null;
}

/** Normalize any captured purchase link to the configured PURCHASE_URL (keeps query). */
function normalizePurchaseUrl(rawHref, PURCHASE_URL) {
    const base = new URL(PURCHASE_URL);      // e.g., https://host/FR/Film-achat.awp
    const captured = new URL(rawHref, base); // resolve relative/raw → absolute
    const qs = captured.search || "";
    return `${base.origin}${base.pathname}${qs}`;
}

function buildBrowserHeaders({ referer }) {
    return {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,image/apng,*/*;q=0.8," +
            "application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        ...(referer ? { "Referer": referer } : {}),
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    };
}

function horaireRefererFor(dateISO, HORAIRE_URL) {
    try {
        const u = new URL(HORAIRE_URL);
        // Most sites accept &P3=YYYY-MM-DD on horaire; even if ignored server-side,
        // it makes the referer look legitimate for the target date.
        const params = new URLSearchParams(u.search);
        params.set("P3", dateISO);
        u.search = params.toString();
        return u.toString();
    } catch {
        return HORAIRE_URL;
    }
}

const WEBDEV_DEBUG = process.env.WEBDEV_DEBUG === "1" || process.env.WEBDEV_DEBUG === "true";

function dlog(...args) {
    if (WEBDEV_DEBUG) console.log("[webdev]", ...args);
}
function derr(...args) {
    if (WEBDEV_DEBUG) console.error("[webdev]", ...args);
}

function joinCookies(cookies = []) {
    // very naive join; good enough for these sites (no commas in values)
    return cookies
        .map(c => String(c).split(";")[0].trim()) // take "name=value"
        .filter(Boolean)
        .join("; ");
}

async function fetchTextAndCookies(url, {
    method = "GET",
    headers = {},
    body = undefined,
    attempts = 3,
    minDelay = 250,
    maxDelay = 900,
} = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            if (WEBDEV_DEBUG) {
                const dbgHeaders = {
                    ...(headers["Referer"] ? { Referer: headers["Referer"] } : {}),
                    ...(headers["Origin"]  ? { Origin:  headers["Origin"]  } : {}),
                    ...(headers["Cookie"]  ? { Cookie:  headers["Cookie"].slice(0, 60) + "…" } : {}),
                    "User-Agent": headers["User-Agent"],
                };
                dlog(`HTTP attempt ${i+1}/${attempts}`, method, url, dbgHeaders);
            }

            const res = await fetch(url, { method, body, headers, redirect: "follow" });
            if (WEBDEV_DEBUG) dlog("→ response", res.status, res.statusText);

            let setCookies = [];
            try {
                const raw = res.headers.getSetCookie?.();
                if (raw && Array.isArray(raw)) setCookies = raw;
                else {
                    const single = res.headers.get("set-cookie");
                    if (single) setCookies = [single];
                }
            } catch { /* ignore */ }

            const text = await res.text();
            return { text, setCookies };
        } catch (e) {
            lastErr = e;
            const info = {
                msg: e?.message,
                name: e?.name,
                code: e?.code || e?.cause?.code,
                errno: e?.errno || e?.cause?.errno,
                syscall: e?.syscall || e?.cause?.syscall,
                undici: e?.cause?.[Symbol.for("undici.error")] || undefined
            };
            derr(`fail ${i+1}/${attempts}`, info);

            if (i < attempts - 1) {
                const delay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
                if (WEBDEV_DEBUG) dlog(`retry in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

/* -------- extra helpers used for dedup and robust matching (top-level) ------ */
function stripEllipses(s=""){ return s.replace(/[.…]+$/g, "").trim(); }
function baseTitle(s=""){
    // normalize, drop trailing ellipses, then lop off subtitles after colon/dash
    const t = stripEllipses(decodeEntities(s))
        .replace(/\u2019/g, "'")
        .normalize("NFD").replace(/\p{Diacritic}/gu, "")
        .toLowerCase().trim();
    // keep the main head before ":" or "-" (helps FR/EN subtitle variants)
    const m = t.match(/^([^:-]{3,})/);
    return (m ? m[1] : t).replace(/\s+/g, " ").trim();
}

/* -------------------------- Built-in cleaners/locators ---------------------- */
/** Mild cleaner: remove attribute-like crumbs that sometimes leak into text */
function cleanAttrCrumbs(s) {
    return s
        .replace(/\b(?:data-[\w-]+|[a-zA-Z-]+-media)\s*=\s*"\[[^"]*\]"\s*/g, " ")
        .replace(/;\s*[a-z-]+\s*:\s*[^;"]+;?/g, " ")
        .replace(/\bvisibility\s*:\s*hidden\b/gi, " ")
        .replace(/\bpos\d+\b/gi, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

/** Aggressive cleaner (Saint-Eustache / RGFM style) */
function cleanAggressiveTitle(s) {
    return cleanAttrCrumbs(
        s
            // kill bracket/JSON-ish tails if leaked
            .replace(/\[[^\]]*\]">?$/g, " ")
            .replace(/["']\s*>?$/g, " ")
            // remove trailing a-media/data-media/style chunks that survived tag strip
            .replace(/\b[a-z-]*media\s*=\s*["'][^"']*["']/gi, " ")
            .replace(/\bstyle\s*=\s*["'][^"']*["']/gi, " ")
            .replace(/\s{2,}/g, " ")
            .trim()
    );
}

/** Default: find nearest header table by marker (A9/A8…) */
function defaultLocateBlock(html, indexInHtml, markerPattern) {
    let marker, lastMarker;
    markerPattern.lastIndex = 0;
    while ((marker = markerPattern.exec(html)) && marker.index < indexInHtml) lastMarker = marker;
    if (!lastMarker) {
        const s = Math.max(0, indexInHtml - 2000);
        const e = Math.min(html.length, indexInHtml + 2000);
        return html.slice(s, e);
    }
    const idIdx = lastMarker.index;
    const tableStart = html.lastIndexOf("<table", idIdx);
    const nextMarkerRel = html.slice(idIdx + 1).search(markerPattern);
    const tableEnd = html.indexOf("</table>", idIdx);
    const end = tableEnd >= 0
        ? tableEnd + "</table>".length
        : (nextMarkerRel >= 0 ? idIdx + 1 + nextMarkerRel : Math.min(html.length, idIdx + 2000));
    return html.slice(Math.max(0, tableStart), end);
}

/** Style/row-aware locator: anchor by style snippets (e.g., 'margin-bottom:-1px'), then expand */
function locateByStyleOrMarker(html, indexInHtml, {
    markerPattern = /id="zrl_(\d+)_A9"/g,
    styleAnchors = [],
    lookBehind = 1200,
    lookAhead = 1600,
    expand = "table", // 'row' | 'table'
} = {}) {
    // 1) Try style anchors nearest BEFORE the link
    let anchor = -1;
    for (const sig of styleAnchors) {
        const a = html.lastIndexOf(sig, indexInHtml);
        if (a > anchor) anchor = a;
    }

    // 2) Fallback to marker
    if (anchor < 0) {
        let m, last = -1;
        markerPattern.lastIndex = 0;
        while ((m = markerPattern.exec(html)) && m.index < indexInHtml) last = m.index;
        anchor = (last >= 0) ? last : Math.max(0, indexInHtml - lookBehind);
    }

    if (expand === "row") {
        let rowStart = html.lastIndexOf("<tr", anchor);
        if (rowStart < 0) rowStart = html.lastIndexOf("<table", anchor);
        let rowEnd = html.indexOf("</tr>", anchor);
        if (rowEnd < 0) rowEnd = html.indexOf("</table>", anchor);
        if (rowEnd < 0) rowEnd = Math.min(html.length, anchor + lookAhead);
        return html.slice(Math.max(0, rowStart), Math.min(html.length, rowEnd + 5));
    }

    // expand == "table" (default)
    const tableStart = html.lastIndexOf("<table", anchor);
    let tableEnd = html.indexOf("</table>", anchor);
    if (tableStart < 0 && tableEnd < 0) {
        const s = Math.max(0, anchor - lookBehind);
        const e = Math.min(html.length, anchor + lookAhead);
        return html.slice(s, e);
    }
    if (tableStart < 0) return html.slice(Math.max(0, anchor - lookBehind), Math.min(html.length, tableEnd + 8));
    if (tableEnd < 0) tableEnd = Math.min(html.length, anchor + lookAhead);
    return html.slice(Math.max(0, tableStart), Math.min(html.length, tableEnd + 8));
}

function defaultPostCleanTitle(title) { return title; }

/* ---------------------------------- parsing -------------------------------- */
function parseHoraire(html, {
    PURCHASE_URL,
    markerPattern = /id="zrl_(\d+)_A9"/g,
    hooks = {},
    styleAnchors,    // array<string> to activate style-based locator
    locateExpand = "table",
}) {
    const out = [];
    if (!html) return out;

    // Capture link + attrs + body to find times inside anchors
    const reLink = /<a[^>]+href="([^"]*?\bFilm-achat\.awp[^"]*?\bP3=(\d+)[^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;
    const timePat       = /\b(\d{1,2})[:hH](\d{2})\b/;          // 19:10 or 19h10
    const timePatLoose  = /\b(\d{1,2})\s*[hH:]\s*(\d{2})\b/;    // also 19 h 10

    // Pick locator
    const locateBlock =
        hooks.locateBlock ||
        (Array.isArray(styleAnchors) && styleAnchors.length
            ? (h, idx) => locateByStyleOrMarker(h, idx, { markerPattern, styleAnchors, expand: locateExpand })
            : (h, idx) => defaultLocateBlock(h, idx, markerPattern));

    // Pick cleaner
    const postCleanTitle = hooks.postCleanTitle || defaultPostCleanTitle;

    let m;
    while ((m = reLink.exec(html))) {
        const linkIdx = m.index;
        const hrefRaw = decodeEntities(m[1]);
        const url = normalizePurchaseUrl(hrefRaw, PURCHASE_URL);

        const attrs = m[3] || "";
        const body  = m[4] || "";

        // time near the link (wider window) + inside the anchor
        const around = html.slice(Math.max(0, linkIdx - 800), Math.min(html.length, reLink.lastIndex + 800));
        const bigBlob = `${attrs} ${body} ${around}`;
        let tm = bigBlob.match(timePat) || bigBlob.match(timePatLoose);
        let time = tm ? hhmmFlexible(tm[0]) : null;

        // locate and sanitize block
        let fragment = locateBlock(html, linkIdx);
        let blockText = decodeEntities(
            fragment
                .replace(/<script[\s\S]*?<\/script>/gi, " ")
                .replace(/<style[\s\S]*?<\/style>/gi, " ")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
        );

        // generic scrub
        blockText = blockText
            .replace(/id="zrl_\d+_A9"\s*/g, " ")
            .replace(/\b\d{6}\b/g, " ")
            .replace(/\b(?:VF|VO|VOA|VOSTA|VOSTFR|FR|ENG)\b/gi, " ")
            .replace(/\b(?:IMAX|ATMOS|4DX|3D|2D)\b/gi, " ")
            .replace(/\s{2,}/g, " ")
            .trim();

        if (!time) {
            const alt = blockText.match(timePat) || blockText.match(timePatLoose);
            time = alt ? hhmmFlexible(alt[0]) : null;
        }

        // Title = everything before first time
        let title = blockText;
        const firstTime = blockText.match(timePat) || blockText.match(timePatLoose);
        if (firstTime && firstTime.index > 0) title = blockText.slice(0, firstTime.index);
        title = title.replace(/[|,;:\-]\s*$/g, "").trim();

        // provider-specific cleanup if any
        title = postCleanTitle(title);

        out.push({
            title,
            rawTitle: title,
            time,
            rawTime: tm?.[0] || (firstTime ? firstTime[0] : null),
            url,
            dateISO: null,
        });
    }

    // de-dup by baseTitle+time (anchors may repeat for same show)
    const seen = new Set();
    return out.filter(x => {
        const k = `${baseTitle(x.title)}|${x.time || ""}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** Parse purchase HTML → { auditorium, seatsRemaining, time, headerLine } */
function parsePurchase(html) {
    if (!html) return { auditorium: null, seatsRemaining: null, time: null, headerLine: null };
    const text = decodeEntities(
        html.replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
    const headerRe = /([A-Za-zéèêàîôûç ,'-]+-\s*\d{1,2}[:hH]\d{2}\s*-\s*Salle\s*[A-Za-z0-9 ]+[^|]*?)(?=\s{2,}|$)/i;
    const h = text.match(headerRe)?.[1] || text;

    const aud = h.match(/\bSalle\s*([A-Za-z0-9 ]+)\b/i)?.[0] || null;
    const seats =
        h.match(/\b(?:places?|Place(?:s)?)[^\d]{0,10}(?:disp\.?|disponibles?)\s*:\s*(\d+)\b/i)?.[1] ||
        text.match(/\b(?:places?|Place(?:s)?)[^\d]{0,10}(?:disp\.?|disponibles?)\s*:\s*(\d+)\b/i)?.[1] ||
        null;

    const t = hhmmFlexible(h) || hhmmFlexible(text);

    return {
        auditorium: aud ? aud.replace(/\s{2,}/g, " ").trim() : null,
        seatsRemaining: seats ? Number(seats) : null,
        time: t,
        headerLine: h || null,
    };
}

/* -------------------------------- fetch helpers ----------------------------- */
async function fetchWithRetry(url, {
    method = "GET",
    headers = {},
    body = undefined,
    attempts = 3,
    minDelay = 250,
    maxDelay = 900,
} = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, {
                method,
                body,
                headers,
                redirect: "follow",
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (e) {
            lastErr = e;
            // jittered backoff on network errors
            if (i < attempts - 1) {
                const delay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

/* ---------------------------- Provider factory API -------------------------- */
export function makeWebDevProvider(cfg) {
    const {
        HORAIRE_URL, PURCHASE_URL,
        markerPattern = /id="zrl_(\d+)_A9"/g,
        styleAnchors,
        locateExpand = "table",
        hooks = {},
    } = cfg;

    function minutesDiff(hhmmA, hhmmB){
        if(!hhmmA || !hhmmB) return Infinity;
        const [aH,aM] = hhmmA.split(":").map(Number);
        const [bH,bM] = hhmmB.split(":").map(Number);
        return Math.abs((aH*60+aM) - (bH*60+bM));
    }
    function overlapScoreTokens(a, b){
        const A = new Set(a.split(" ").filter(w=>w.length>2));
        const B = new Set(b.split(" ").filter(w=>w.length>2));
        let s = 0; for(const w of A) if (B.has(w)) s++;
        return s;
    }

    // simple in-memory jar per provider instance
    let jarCookie = "";   // e.g. "PCSID=abc; other=xyz"
    const ORIGIN = (() => { try { return new URL(HORAIRE_URL).origin; } catch { return undefined; } })();

    return {
        async fetchDay(dateISO) {
            const url = `${HORAIRE_URL}${HORAIRE_URL.includes("?") ? "&" : "?"}P3=${encodeURIComponent(dateISO)}`;
            const headers = {
                ...buildBrowserHeaders({ referer: horaireRefererFor(dateISO, HORAIRE_URL) }),
                ...(ORIGIN ? { "Origin": ORIGIN } : {}),
            };
            if (WEBDEV_DEBUG) dlog("horaire GET", url, { Referer: headers.Referer, Origin: headers.Origin });

            const { text: html, setCookies } = await fetchTextAndCookies(url, { headers, attempts: 3 });
            if (setCookies?.length) {
                jarCookie = joinCookies(setCookies);
                if (WEBDEV_DEBUG) dlog("captured cookies", jarCookie);
            }
            const list = parseHoraire(html, { PURCHASE_URL, markerPattern, hooks, styleAnchors, locateExpand })
                .map(x => ({ ...x, dateISO }));
            return list;
        },

        async scrapeFromPurchaseUrl(purchaseUrl, dateISO) {
            const headers = {
                ...buildBrowserHeaders({ referer: horaireRefererFor(dateISO, HORAIRE_URL) }),
                ...(ORIGIN ? { "Origin": ORIGIN } : {}),
                ...(jarCookie ? { "Cookie": jarCookie } : {}),
            };

            let url = purchaseUrl;
            try { const u = new URL(purchaseUrl); u.searchParams.set("_", Date.now().toString(36)); url = u.toString(); } catch {}

            if (WEBDEV_DEBUG) {
                const dbg = { Referer: headers.Referer, Origin: headers.Origin, Cookie: jarCookie ? jarCookie.slice(0, 60) + "…" : undefined };
                dlog("purchase GET", url, dbg);
            }

            const { text: html } = await fetchTextAndCookies(url, { headers, attempts: 3 });
            const { auditorium, seatsRemaining } = parsePurchase(html);
            return {
                measured_at: new Date().toISOString(),
                seats_remaining: Number.isFinite(seatsRemaining) ? seatsRemaining : null,
                auditorium: auditorium || null,
                source: "webdev",
                url: purchaseUrl,
            };
        },

        async getSeats({ dateISO, hhmm, title }) {
            const shows = await this.fetchDay(dateISO);

            const wantExact = normTitle(title);
            const wantBase  = baseTitle(title);

            // 1) strict time match first
            let candidates = shows.filter(x => x.time === hhmm);

            // 2) if none, allow ±10 minutes and pick closest
            if (!candidates.length) {
                const within10 = shows
                    .map(x => ({ ...x, _dt: minutesDiff(x.time, hhmm) }))
                    .filter(x => x._dt <= 10)
                    .sort((a,b)=>a._dt - b._dt);
                if (within10.length) {
                    const bestTime = within10[0]._dt;
                    candidates = within10.filter(x => x._dt === bestTime); // keep ties
                }
            }

            // 3) score by title (exact → startsWith on base → token overlap on base)
            const wantTokens = wantBase;
            const scored = candidates.map(x => {
                const exact  = (normTitle(x.title) === wantExact) ? 3 : 0;
                const starts = baseTitle(x.title).startsWith(wantBase) ? 2 : 0;
                const overlap = overlapScoreTokens(baseTitle(x.title), wantTokens); // 0..N
                const score = (exact || starts) ? (exact || starts) * 100 + overlap : overlap;
                return { ...x, _score: score };
            }).sort((a,b)=> b._score - a._score);

            // 4) fallback: if still empty (rare), try any show by best textual match
            let picked = scored[0];
            if (!picked && shows.length) {
                const wide = shows.map(x => {
                    const overlap = overlapScoreTokens(baseTitle(x.title), wantTokens);
                    const starts  = baseTitle(x.title).startsWith(wantBase) ? 1 : 0;
                    return { ...x, _score: starts*100 + overlap };
                }).sort((a,b)=>b._score - a._score)[0];
                if (wide && wide._score > 0) picked = wide;
            }

            if (!picked) {
                const dbg = shows.map(x => `- ${x.time} | ${x.title} | ${x.url}`).join("\n");
                throw new Error(`webdev: session not found for ${dateISO} ${hhmm} "${title}"\nKnown:\n${dbg}`);
            }

            // scrape
            return this.scrapeFromPurchaseUrl(picked.url, dateISO);
        }
    };
}

/* ----------------------------- Public internals ---------------------------- */
export const _internal = {
    parseHoraire,
    parsePurchase,
    normalizePurchaseUrl,
    normTitle,
    hhmmFlexible,
    // built-ins for provider configs
    cleaners: { cleanAttrCrumbs, cleanAggressiveTitle },
    locators: { defaultLocateBlock, locateByStyleOrMarker },
};
