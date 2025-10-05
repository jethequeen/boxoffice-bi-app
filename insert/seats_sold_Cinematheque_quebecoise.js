// insert/seats_sold_Cinematheque_quebecoise.js
import vm from "node:vm";
// ⬇️ add these near the top
import { fileURLToPath } from "url";
import path from "path";

/* -------------------- small utils -------------------- */
const BASE = "https://omniwebticketing6.com/cinematheque/";

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
        .replace(/\u2019/g, "'") // curly → straight apostrophe
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}
function hhmm(s = "") {
    const m = String(s).match(/\b(\d{1,2}):(\d{2})\b/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/* -------------------- parser -------------------- */
function parseCinemathequeDay(html) {
    // robust: allow newlines/spaces; stop at </script> to avoid trailing code
    const re = /var\s+gMovieData\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i;
    const m = re.exec(html);
    if (!m) return { sessions: [], raw: null };

    const objectLiteral = m[1];

    // Evaluate object literal safely
    let data;
    try {
        data = vm.runInNewContext(`(${objectLiteral})`, {}, { timeout: 1000 });
    } catch (e) {
        throw new Error("Failed to eval gMovieData: " + (e?.message || e));
    }
    if (!data || typeof data !== "object") return { sessions: [], raw: null };

    // Flatten
    const sessions = [];
    for (const code of Object.keys(data)) {
        const film = data[code] || {};
        const title = decodeEntities(String(film.title || "").trim());
        const schAuds = film.schAuds || {};
        for (const audKey of Object.keys(schAuds)) {
            const aud = schAuds[audKey] || {};
            const audName = String(aud.name || audKey).trim(); // e.g. "SALLE 1"
            const perfs = { ...(aud.schPerfsGeneral || {}), ...(aud.schPerfsReserved || {}) };
            for (const k of Object.keys(perfs)) {
                const p = perfs[k] || {};
                const t = hhmm(p.startTime || p.startTimeStr || k);
                if (!t) continue;
                sessions.push({
                    code: film.code,
                    title,
                    auditorium: audName,                // e.g. "SALLE 1"
                    startTime: t,                       // "HH:MM"
                    schDateStr: p.schDateStr,           // "YYYY-MM-DD"
                    seatsRemaining: Number(p.seatsRemaining ?? NaN),
                    perfIx: p.perfIx || null,
                    linkStr: p.linkStr || null,
                });
            }
        }
    }
    return { sessions, raw: data };
}

function findSessionBy(dateISO, hhmmStr, title, allSessions) {
    const wantDate = String(dateISO);
    const wantTime = hhmm(hhmmStr);
    const wantTitle = normTitle(title);
    return (
        allSessions.find(
            (s) =>
                s.schDateStr === wantDate &&
                s.startTime === wantTime &&
                normTitle(s.title) === wantTitle
        ) || null
    );
}

/* -------------------- fetcher -------------------- */
export async function cinemathequeFetchDay(dateISO) {
    const url = `${BASE}?schdate=${encodeURIComponent(dateISO)}`;
    const res = await fetch(url, {
        redirect: "follow",
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
        },
    });
    if (!res.ok) throw new Error(`cinematheque fetch ${dateISO} failed: ${res.status}`);
    const html = await res.text();
    const { sessions } = parseCinemathequeDay(html);
    return sessions;
}

/**
 * Scrape a single show’s seats for Cinémathèque québécoise.
 * Returns: { measured_at, seats_remaining, auditorium, source }
 */
export async function cinemathequeScrapeSeats({ dateISO, hhmm, title }) {
    const sessions = await cinemathequeFetchDay(dateISO);
    if (!sessions.length) throw new Error(`cinematheque: no sessions on ${dateISO}`);
    const s = findSessionBy(dateISO, hhmm, title, sessions);
    if (!s) {
        // Try loose title (contains) if exact fails
        const wantTime = hhmm;
        const wantNorm = normTitle(title);
        const loose =
            sessions.find(
                (x) => x.startTime === wantTime && normTitle(x.title).includes(wantNorm)
            ) || null;
        if (!loose) throw new Error(`cinematheque: session not found for ${dateISO} ${hhmm} "${title}"`);
        return {
            measured_at: new Date().toISOString(),
            seats_remaining: Number.isFinite(loose.seatsRemaining) ? loose.seatsRemaining : null,
            auditorium: loose.auditorium || null,
            source: "cinematheque",
        };
    }
    return {
        measured_at: new Date().toISOString(),
        seats_remaining: Number.isFinite(s.seatsRemaining) ? s.seatsRemaining : null,
        auditorium: s.auditorium || null,
        source: "cinematheque",
    };
}

// ⬇️ replace your CLI guard with this version
const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
    (async () => {
        try {
            const [, , dateISO, time, ...titleParts] = process.argv;


            if (!time) {
                const list = await cinemathequeFetchDay(dateISO);
                console.log(`[debug] sessions on ${dateISO}: ${list.length}`);
                for (const s of list) {
                    console.log(`- ${s.startTime} | ${s.title} | ${s.auditorium} | seatsRemaining=${s.seatsRemaining}`);
                }
                return;
            }

            const title = (titleParts || []).join(" ").trim();

            const rec = await cinemathequeScrapeSeats({ dateISO, hhmm: time, title });
            console.log("MATCH:", rec);
        } catch (e) {
            console.error("ERR:", e.message);
        }
    })();
}
