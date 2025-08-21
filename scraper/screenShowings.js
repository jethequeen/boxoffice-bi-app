// scraper/screenShowings.js
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { fileURLToPath } from "url";
import path from "path";

const DEFAULT_URL = "https://www.cinoche.com/films/relay/horaires";

/**
 * Scrape ALL days on a Cinoche film showtimes page.
 * Returns one entry per theater per day with its times.
 */
export async function parseCinocheShowtimes(url) {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // 1) Build the date label for each slide (order matters)
    const dayLabels = $(".days-slider-slide .days-slider-slide-trigger-content")
        .map((i, el) => {
            const weekday = $(el).find(".days-slider-weekday.is-not-mobile").text().trim();
            const day = $(el).find(".days-slider-date").text().trim();
            const month = $(el).find(".days-slider-month.is-not-mobile").text().trim();
            return [weekday, day, month].filter(Boolean).join(" ");
        })
        .get();

    const out = [];

    // 2) For each day's section, pair it with the matching label by index
    $(".cinema-schedule-movies").each((i, section) => {
        const date = dayLabels[i] || null;

        // Skip days with no showings
        const $section = $(section);
        const $theaters = $section.find(".theaters-items .theater-item");
        if (!$theaters.length) return;

        $theaters.each((_, th) => {
            // Theater name: be tolerant to minor template changes
            const theater =
                $(th).find(".cinema-schedule-movie-title a").first().text().trim() ||
                $(th).find(".item-title a, .item-title-link").first().text().trim() ||
                $(th).find("a").first().text().trim();

            // Times
            const times = $(th)
                .find(".cinema-schedule-movie-time, .movie-time, .session-time")
                .map((__, t) => $(t).text().trim())
                .get()
                .filter(Boolean);

            out.push({ date, theater, times, count: times.length });
        });
    });

    return out;
}

// CLI usage: node scraper/screenShowings.js <url>
if (process.argv[1]?.endsWith("screenShowings.js") && process.argv[2]) {
    parseCinocheShowtimes(process.argv[2])
        .then((data) => console.log(JSON.stringify(data, null, 2)))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

/* ---------- robust Windows-friendly CLI guard ---------- */
const isDirectRun =
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "");

if (isDirectRun) {
    const url = process.argv[2] || DEFAULT_URL;
    try {
        const data = await parseCinocheShowtimes(url);
        console.log(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error("Scrape error:", err?.message || err);
        process.exit(1);
    }
}


