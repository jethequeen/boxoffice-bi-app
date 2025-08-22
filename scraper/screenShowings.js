import fetch from "node-fetch";
import * as cheerio from "cheerio";

function extractChainAndScreens($scope) {
    // Try a few places; fall back to any text that mentions "salle(s)"
    const candidates = [
        $scope.find(".cinema-schedule-movie-subtitle").text(),
        $scope.find(".item-subtitle").text(),
        $scope.find(".theater-subtitle").text(),
        $scope.find(".cinema-schedule-movie-title").parent().text(),
        $scope.text()
    ].map(t => t.trim()).filter(Boolean);

    const meta = candidates.find(t => /salle/i.test(t)) || "";
    const company = (meta.split("•")[0] || "").trim() || null;

    const m = meta.match(/(\d+)\s+salle/i); // matches "1 salle", "10 salles"
    const screenCount = m ? parseInt(m[1], 10) : null;

    return { company, screenCount };
}

export async function parseCinocheShowtimes(url) {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const dayLabels = $(".days-slider-slide .days-slider-slide-trigger-content")
        .map((i, el) => {
            const weekday = $(el).find(".days-slider-weekday.is-not-mobile").text().trim();
            const day = $(el).find(".days-slider-date").text().trim();
            const month = $(el).find(".days-slider-month.is-not-mobile").text().trim();
            return [weekday, day, month].filter(Boolean).join(" ");
        })
        .get();

    const out = [];

    $(".cinema-schedule-movies").each((i, section) => {
        const date = dayLabels[i] || null;
        const $section = $(section);
        const $theaters = $section.find(".theaters-items .theater-item");
        if (!$theaters.length) return;

        $theaters.each((_, th) => {
            const $th = $(th);

            const theater =
                $th.find(".cinema-schedule-movie-title a").first().text().trim() ||
                $th.find(".item-title a, .item-title-link").first().text().trim() ||
                $th.find("a").first().text().trim();

            const { company, screens } = extractChainAndScreens($th);

            const times = $th
                .find(".cinema-schedule-movie-time, .movie-time, .session-time")
                .map((__, t) => $(t).text().trim())
                .get()
                .filter(Boolean);

            out.push({
                date,
                theater,
                company,
                screens,
                times,
                count: times.length
            });
        });
    });

    return out;
}



