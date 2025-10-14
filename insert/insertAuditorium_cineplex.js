// insert/insertAuditorium_cineplex.js
import puppeteer from "puppeteer";

const SHOWTIMES_PREFIX = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1/showtimes";

// --- utils ---
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const squish = (s) => norm(s).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const toMDY = (iso) => {
    const [Y, M, D] = iso.split("-").map(Number);
    return `${M}/${D}/${Y}`;
};

const hhmmFrom = (s) => {
    if (!s) return "";
    const t = s.includes("T") ? s.split("T")[1] : s;
    return t.slice(0, 5); // HH:MM
};

// Flatten Cineplex payload to session candidates
function flattenShowtimesPayload(json) {
    const out = [];
    const movies = json?.dates?.[0]?.movies ?? [];
    for (const m of movies) {
        for (const exp of m.experiences ?? []) {
            for (const s of exp.sessions ?? []) {
                out.push({
                    movieName: m.name,
                    filmUrl: m.filmUrl,
                    runtimeInMinutes: m.runtimeInMinutes,
                    languageCode: m.languageCode,
                    experienceTypes: exp.experienceTypes,
                    auditorium: s.auditorium,
                    showStartDateTime: s.showStartDateTime,        // local wall time
                    showStartDateTimeUtc: s.showStartDateTimeUtc,  // UTC (no Z)
                    vistaSessionId: s.vistaSessionId,
                    seatsRemaining: s.seatsRemaining,
                    areaCode: s.areaCode,
                    seatMapUrl: s.seatMapUrl || null,
                });
            }
        }
    }
    return out;
}

// --- dedupe helpers ---
function sessionKey(r) {
    return r.vistaSessionId
        ? `v:${r.vistaSessionId}`
        : `k:${(r.auditorium || "").trim()}|${r.showStartDateTimeUtc || r.showStartDateTime || ""}|${r.filmUrl || r.movieName || ""}`;
}
function areaPriority(areaCode) {
    if (areaCode === "0000000001") return 3; // GA
    if (areaCode === "0000000004") return 1; // D-BOX
    return 2;
}
function experiencePriority(expTypes) {
    const arr = Array.isArray(expTypes) ? expTypes.map((x) => String(x).toLowerCase()) : [];
    if (arr.some((x) => x.includes("regular"))) return 2;
    if (arr.some((x) => x.includes("d-box") || x.includes("dbox"))) return 1;
    return 0;
}
function dedupeSessions(cands) {
    const byKey = new Map();
    for (const r of cands) {
        const key = sessionKey(r);
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, r); continue; }
        const prevScore = areaPriority(prev.areaCode) * 100 + experiencePriority(prev.experienceTypes);
        const nextScore = areaPriority(r.areaCode)   * 100 + experiencePriority(r.experienceTypes);
        if (nextScore > prevScore) byKey.set(key, r);
    }
    return Array.from(byKey.values());
}

// --- auditorium matching helpers (DB) ---
function normalizeAudName(s) {
    return (s || "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\b(salle|aud|auditorium|screen|vip)\b/g, "")
        .replace(/[#]/g, "")
        .replace(/\s+/g, "")
        .replace(/(^|[^\d])0+(\d)/g, "$1$2");
}
function extractDigits(s) {
    const m = (s || "").match(/\d+/g);
    return m ? m.join("") : "";
}

/** Get the Ocp-Apim-Subscription-Key by visiting a theatre page once. */
export async function getShowtimesKeyFromTheatreUrl(theatreUrl) {
    const browser = await puppeteer.launch({ headless: "new" });
    try {
        const page = await browser.newPage();
        let key = null;
        page.on("request", (req) => {
            if (req.url().startsWith(SHOWTIMES_PREFIX)) {
                const k = req.headers()["ocp-apim-subscription-key"];
                if (k) key = k;
            }
        });
        await page.goto(theatreUrl, { waitUntil: "networkidle2", timeout: 45000 });
        if (!key) await new Promise((r) => setTimeout(r, 800));
        if (!key) throw new Error("Could not capture Ocp-Apim-Subscription-Key");
        return key;
    } finally {
        await browser.close();
    }
}

/**
 * Fetch Cineplex showtimes once, then:
 *  - filter by date & exact HH:MM
 *  - tie-break: runtime (±3), then fuzzy title, then GA preference
 */
export async function fetchSeatsForShowtime({
                                                locationId,
                                                date,          // "YYYY-MM-DD"
                                                movieTitle,    // fuzzy, used for tie-breaks
                                                showtime,      // "HH:MM"
                                                lang = "fr",
                                                showtimesKey,
                                                wantRuntime = null,
                                            }) {
    if (!showtimesKey) throw new Error("showtimesKey required");

    const url = `${SHOWTIMES_PREFIX}?language=${encodeURIComponent(lang)}&locationId=${encodeURIComponent(
        String(locationId)
    )}&date=${encodeURIComponent(toMDY(date))}`;

    const res = await fetch(url, { headers: { Accept: "application/json", "Ocp-Apim-Subscription-Key": showtimesKey }});
    if (!res.ok) throw new Error(`Showtimes fetch failed: ${res.status}`);

    const payload = await res.json();
    const blocks = Array.isArray(payload) ? payload : [payload];

    // Flatten + dedupe globally
    let all = [];
    for (const blk of blocks) all = all.concat(flattenShowtimesPayload(blk));
    all = dedupeSessions(all);

    const todays = all.filter((r) => (r.showStartDateTime || "").slice(0, 10) === date);
    const wantHHMM = showtime.slice(0, 5);

    // Exact minute
    let atMinute = todays.filter((r) => hhmmFrom(r.showStartDateTime) === wantHHMM);
    if (atMinute.length === 0) {
        throw new Error(`match-failed ${JSON.stringify({ status: "NO_MATCH_AT_TIME", theatreId: locationId, wantTime: wantHHMM })}`);
    }

    // runtime (±3)
    if (Number.isFinite(wantRuntime) && atMinute.some(r => Number.isFinite(r.runtimeInMinutes))) {
        const withRt = atMinute.filter(r => Number.isFinite(r.runtimeInMinutes));
        const byRt   = withRt.filter(r => Math.abs(r.runtimeInMinutes - wantRuntime) <= 3);
        if (byRt.length === 1)       atMinute = byRt;
        else if (byRt.length > 1)    atMinute = byRt;
    }

    // title (loose)
    if (atMinute.length > 1 && movieTitle) {
        const want = norm(movieTitle);
        const wantLoose = squish(movieTitle);
        const narrowed = atMinute.filter(r => {
            const n = norm(r.movieName);
            const sq = squish(r.movieName);
            return n.includes(want) || sq.includes(wantLoose);
        });
        if (narrowed.length > 0) atMinute = narrowed;
    }

    // GA / auditorium group
    if (atMinute.length > 1) {
        const audSet = new Set(atMinute.map(r => (r.auditorium || "").trim()));
        if (audSet.size === 1) return atMinute[0];
        const ga = atMinute.find(r => r.areaCode === "0000000001");
        if (ga) return ga;
    }

    return atMinute[0];
}

/** SCRAPE-ONLY for daemon; no DB writes. */
export async function scrapeSeatsOnly({
                                          movieTitle,
                                          local_date,  // "YYYY-MM-DD"
                                          local_time,  // "HH:MM"
                                          locationId,
                                          showtimesKey,
                                          lang = "fr",
                                          wantRuntime = null,
                                      }) {
    const info = await fetchSeatsForShowtime({
        locationId,
        date: local_date,
        movieTitle,
        showtime: local_time,
        lang,
        showtimesKey,
        wantRuntime,
    });

    const srRaw = info?.seatsRemaining;
    const srNum = srRaw == null || srRaw === "" ? null : Number(srRaw);

    return {
        measured_at: new Date().toISOString(),
        seats_remaining: Number.isNaN(srNum) ? null : srNum,
        capacity: null,                       // hydrate later
        auditorium: (info.auditorium || "").trim() || null,
        source: "cineplex",
    };
}

/**
 * OLD path: Upsert seats_sold with its own fetch/matching (kept for other callers).
 */
export async function upsertSeatsSold({
                                          pgClient,
                                          movie_id,
                                          theater_id,
                                          local_date,
                                          local_time,
                                          movieTitle,
                                          locationId,
                                          showtimesKey,
                                          theatreUrl,
                                          lang = "fr",
                                      }) {
    // Resolve locationId + key if needed
    let locId = locationId;
    let key = showtimesKey;

    if (!locId || !key) {
        const q = await pgClient.query(
            `SELECT theater_api_id, showings_url FROM theaters WHERE id = $1 LIMIT 1`,
            [theater_id]
        );
        if (q.rowCount === 0) throw new Error(`theater_id=${theater_id} not found`);
        locId = locId || q.rows[0].theater_api_id;
        if (!locId) throw new Error(`theater_id=${theater_id} missing theater_api_id`);
        if (!key) {
            const url = theatreUrl || q.rows[0].showings_url;
            if (!url) throw new Error(`No theatre URL on theaters.showings_url for theater_id=${theater_id}`);
            key = await getShowtimesKeyFromTheatreUrl(url);
        }
    }

    // Fetch movie runtime (best-effort)
    let wantRuntime = null;
    try {
        const mq = await pgClient.query(`SELECT * FROM movies WHERE id = $1 LIMIT 1`, [movie_id]);
        if (mq.rowCount) {
            const r = mq.rows[0];
            const candidates = [r.runtime_minutes, r.runtime, r.length_minutes, r.duration_minutes, r.duration];
            for (const v of candidates) { const n = Number(v); if (Number.isFinite(n) && n > 0) { wantRuntime = n; break; } }
        }
    } catch (_) {}

    // Fetch + match
    const info = await fetchSeatsForShowtime({
        locationId: locId,
        date: local_date,
        movieTitle,
        showtime: local_time,
        lang,
        showtimesKey: key,
        wantRuntime,
    });

    if (info.seatsRemaining == null) throw new Error("seatsRemaining is null in Cineplex payload");

    // Match screen & capacity
    const auditoriumRaw = (info.auditorium || "").trim();
    const audNorm = normalizeAudName(auditoriumRaw);
    const audDigits = extractDigits(auditoriumRaw);

    // 1) exact
    let res = await pgClient.query(
        `SELECT id, name, seat_count FROM screens WHERE theater_id = $1 AND name = $2 LIMIT 1`,
        [theater_id, auditoriumRaw]
    );

    // 2) normalized best pick
    if (res.rowCount === 0) {
        const all = await pgClient.query(`SELECT id, name, seat_count FROM screens WHERE theater_id = $1`, [theater_id]);
        let best = null;
        for (const row of all.rows) {
            const n = normalizeAudName(row.name);
            const d = extractDigits(row.name);
            let score = 3; // lower is better
            if (n === audNorm) score = 0;
            else if (d && d === audDigits) score = 1;
            else if (n && audNorm && (n.includes(audNorm) || audNorm.includes(n))) score = 1.5;

            if (!best || score < best.score || (score === best.score && (row.name || "").length < (best.row.name || "").length)) {
                best = { row, score };
            }
        }
        if (best && best.score <= 1.5) res = { rowCount: 1, rows: [best.row] };
    }

    // 3) last resort: legacy ILIKE
    if (res.rowCount === 0) {
        res = await pgClient.query(
            `SELECT id, name, seat_count FROM screens WHERE theater_id = $1 AND name ILIKE $2 ORDER BY LENGTH(name) ASC LIMIT 1`,
            [theater_id, `%${auditoriumRaw}%`]
        );
    }

    if (res.rowCount === 0) throw new Error(`No screen matched auditorium="${auditoriumRaw}" in theater_id=${theater_id}`);

    const screen_id = res.rows[0].id;
    const capacity  = Number(res.rows[0].seat_count) || 0;
    const remaining = Number(info.seatsRemaining);
    const seats_sold = Math.max(0, capacity - remaining);

    const start_at = info.showStartDateTimeUtc
        ? new Date(info.showStartDateTimeUtc + "Z").toISOString()
        : `${local_date}T${local_time}:00Z`;

    const up = await pgClient.query(
        `
      INSERT INTO showings (movie_id, theater_id, start_at, date, screen_id, seats_sold)
      VALUES ($1, $2, $3::timestamptz, $4::date, $5, $6)
          ON CONFLICT (movie_id, theater_id, start_at, date)
  DO UPDATE SET
          screen_id = COALESCE(showings.screen_id, EXCLUDED.screen_id),
                   seats_sold = EXCLUDED.seats_sold,
                   scraped_at = now()

      RETURNING *
    `,
        [movie_id, theater_id, start_at, local_date, screen_id, seats_sold]
    );

    return {
        theater_id,
        movie_id,
        screen_id,
        auditorium: auditoriumRaw,
        capacity,
        remaining,
        seats_sold,
        start_at: up.rows[0].start_at,
        row: up.rows[0],
    };
}

/**
 * NEW: Upsert using an ALREADY SCRAPED measurement (no re-scrape).
 * - measurement must include: showing_id, theater_id, movie_id, auditorium, seats_remaining
 * - will update showings by id (assumes row exists from scheduling query)
 */
export async function upsertSeatsSoldFromMeasurement({
                                                         pgClient,
                                                         measurement, // { showing_id, theater_id, movie_id, auditorium, seats_remaining }
                                                     }) {
    const { showing_id, theater_id, movie_id, auditorium, seats_remaining } = measurement;

    if (seats_remaining == null) {
        throw new Error(`measurement has null seats_remaining for showing_id=${showing_id}`);
    }

    const auditoriumRaw = (auditorium || "").trim();
    const audNorm = normalizeAudName(auditoriumRaw);
    const audDigits = extractDigits(auditoriumRaw);

    // 1) exact
    let res = await pgClient.query(
        `SELECT id, name, seat_count FROM screens WHERE theater_id = $1 AND name = $2 LIMIT 1`,
        [theater_id, auditoriumRaw]
    );

    // 2) normalized best pick
    if (res.rowCount === 0) {
        const all = await pgClient.query(`SELECT id, name, seat_count FROM screens WHERE theater_id = $1`, [theater_id]);
        let best = null;
        for (const row of all.rows) {
            const n = normalizeAudName(row.name);
            const d = extractDigits(row.name);
            let score = 3;
            if (n === audNorm) score = 0;
            else if (d && d === audDigits) score = 1;
            else if (n && audNorm && (n.includes(audNorm) || audNorm.includes(n))) score = 1.5;
            if (!best || score < best.score || (score === best.score && (row.name || "").length < (best.row.name || "").length)) {
                best = { row, score };
            }
        }
        if (best && best.score <= 1.5) res = { rowCount: 1, rows: [best.row] };
    }

    // 3) ILIKE fallback
    if (res.rowCount === 0) {
        res = await pgClient.query(
            `SELECT id, name, seat_count FROM screens WHERE theater_id = $1 AND name ILIKE $2 ORDER BY LENGTH(name) ASC LIMIT 1`,
            [theater_id, `%${auditoriumRaw}%`]
        );
    }

    if (res.rowCount === 0) {
        throw new Error(`No screen matched auditorium="${auditoriumRaw}" in theater_id=${theater_id}`);
    }

    const screen_id  = res.rows[0].id;
    const capacity   = Number(res.rows[0].seat_count) || 0;
    const remaining  = Number(seats_remaining);
    const seats_sold = Math.max(0, capacity - remaining);

    await pgClient.query(
        `UPDATE showings
         SET seats_sold = $1,
             scraped_at = now()
         WHERE id = $2
           AND seats_sold IS DISTINCT FROM $1`,
        [seats_sold, showing_id]
    );

    await pgClient.query(
        `UPDATE showings
     SET screen_id = $1
   WHERE id = $2
     AND screen_id IS NULL`,
        [screen_id, showing_id]
    );


    return { theater_id, movie_id, screen_id, auditorium: auditoriumRaw, capacity, remaining, seats_sold };
}
