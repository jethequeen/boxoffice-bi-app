import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { parseCinocheShowtimes } from "./screenShowings.js";

const LIST_URL     = "https://www.cinoche.com/films";
const UPCOMING_URL = "https://www.cinoche.com/films/a-venir";

async function fetchHtml(url) {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

function normalizeHref(href) { return href.split("?")[0].replace(/\/$/, ""); }

function slugToTitle(href) {
    const slug = href.split("?")[0].replace(/\/$/, "").split("/").pop() || "Film";
    return slug.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function parseFilmsFromListing(html) {
    const $ = cheerio.load(html);
    const picked = new Map(); // href -> title
    $('a[href^="/films/"]').each((_, a) => {
        const hrefRaw = $(a).attr("href");
        if (!hrefRaw) return;
        const href = hrefRaw.split("?")[0].replace(/\/$/, "");
        if (!/^\/films\/[^/]+$/.test(href)) return;
        const title =
            $(a).attr("title")?.trim() ||
            $(a).find("img[alt]").attr("alt")?.trim() ||
            $(a).text().trim() ||
            slugToTitle(href);
        if (!picked.has(href)) picked.set(href, title);
    });
    return [...picked.entries()].map(([href, title]) => ({ href, title }));
}

// French months
const MONTHS = { janvier:1, février:2, fevrier:2, mars:3, avril:4, mai:5, juin:6,
    juillet:7, août:8, aout:8, septembre:9, octobre:10, novembre:11,
    décembre:12, decembre:12 };

function parseFrenchDateToISO(label) {
    if (!label) return null;
    const parts = label.toLowerCase().trim().split(/\s+/);
    const dRaw = parts.find((p) => /^\d{1,2}(er)?$/.test(p)) || "";
    const day = parseInt(dRaw.replace("er",""), 10);
    const monthWord = parts.find((p) => MONTHS[p]);
    const month = MONTHS[monthWord] || null;
    if (!day || !month) return null;
    const now = new Date();
    let year = now.getFullYear();
    if (month === 1 && now.getMonth() === 11) year = now.getFullYear() + 1;
    return `${String(year)}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function toHorairesUrl(hrefOrUrl) {
    const base = "https://www.cinoche.com";
    const u = hrefOrUrl.startsWith("http") ? new URL(hrefOrUrl) : new URL(hrefOrUrl, base);
    if (!u.pathname.endsWith("/horaires")) u.pathname = u.pathname.replace(/\/$/, "") + "/horaires";
    return u.toString();
}

function normalizeTime(raw) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/[^\dh:]/gi, "").replace(/\s+/g, "");
    const m = s.match(/^(\d{1,2})[:hH](\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh === 24) hh = 0;
    if (hh > 23 || mm > 59) return null;
    return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
}

// simple worker pool
async function mapPool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.max(1, limit|0) }, async () => {
        while (i < items.length) {
            const idx = i++;
            try { out[idx] = await fn(items[idx], idx); }
            catch { out[idx] = null; }
        }
    });
    await Promise.all(workers);
    return out;
}

/**
 * Returns:
 * [{ title, href, source: 'now'|'upcoming', horairesUrl, total, blocks: [{dateISO, theater, times, chain?, screenCount?}] }]
 */
export async function getProgram({
                                     minShowsNow = 5,
                                     minShowsUpcoming = 1,         // <-- key change
                                     maxFilms = Infinity,
                                     concurrency = 6,
                                 } = {}) {
    // 1) Fetch and parse both pages
    const [nowHtml, upcomingHtml] = await Promise.all([
        fetchHtml(LIST_URL),
        fetchHtml(UPCOMING_URL),
    ]);

    const nowList = parseFilmsFromListing(nowHtml);
    const upcList = parseFilmsFromListing(upcomingHtml);

    // 2) Merge by href but keep origin
    const merged = new Map(); // key -> { href, title, source }
    for (const f of nowList) merged.set(normalizeHref(f.href), { ...f, source: "now" });
    for (const f of upcList) {
        const key = normalizeHref(f.href);
        if (!merged.has(key)) merged.set(key, { ...f, source: "upcoming" });
    }

    // 3) Cap after merge
    const films = [...merged.values()].slice(0, maxFilms);
    if (!films.length) return [];

    // (optional) basic instrumentation
    console.log(`Index -> now:${nowList.length} upcoming:${upcList.length} unique:${films.length}`);

    // 4) Scrape horaires with a pool
    const cache = new Map();
    const results = await mapPool(films, concurrency, async (film) => {
        const horairesUrl = toHorairesUrl(film.href);
        try {
            const blocksRaw = cache.get(horairesUrl) || await parseCinocheShowtimes(horairesUrl);
            cache.set(horairesUrl, blocksRaw);

            const normalized = (blocksRaw || []).map((b) => {
                const times = Array.from(new Set(
                    (Array.isArray(b.times) ? b.times : [])
                        .map(normalizeTime)
                        .filter(Boolean)
                ));
                return {
                    dateISO: parseFrenchDateToISO(b.date),
                    theater: (b.theater || "").trim(),
                    times,
                    chain: b.chain ?? null,
                    screenCount: b.screenCount ?? null,
                };
            }).filter((b) => b.dateISO && b.theater && b.times.length);

            const total = normalized.reduce((s, b) => s + b.times.length, 0);

            // use different thresholds based on origin
            const minReq = film.source === "upcoming" ? minShowsUpcoming : minShowsNow;
            if (total >= minReq) {
                return { ...film, horairesUrl, total, blocks: normalized };
            }
            return null;
        } catch {
            return null;
        }
    });

    return results.filter(Boolean);
}
