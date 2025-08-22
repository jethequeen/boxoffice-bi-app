import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

export async function getCinocheHtml(date) {
    const url = `https://www.cinoche.com/films/box-office/${date}`;
    const res = await fetch(url);
    return await res.text();
}

function parseMoney(text) {
    const cleaned = text.replace(/\s|&nbsp;|\$/g, "").replace(",", ".").trim();

    const match = cleaned.match(/^([\d.]+)M/i);
    if (match) {
        return Math.round(parseFloat(match[1]) * 1_000_000);
    }

    const numeric = parseFloat(cleaned);
    return isNaN(numeric) ? null : Math.round(numeric);
}


export function extractBoxOfficeMap(html, sectionClass) {
    const $ = cheerio.load(html);
    const section = $(`.box-office-wrapper.${sectionClass}`);
    const rows = section.find("tr.table-row");

    const isUS = sectionClass.includes("murica");
    const map = new Map();

    rows.each((i, el) => {
        const titleEl = $(el).find("h2.movie-title a");
        const title = titleEl.text().trim();
        const href = titleEl.attr("href");
        const fullUrl = href?.startsWith("http") ? href : `https://www.cinoche.com${href}`;

        const voMatch = $(el).find(".movie-infos").text().match(/\(([^()]+)\s+-\s+V\.O\.A\./);
        const enTitle = voMatch ? voMatch[1].trim() : title;

        let weekEnd;
        let cumulative;

        if (isUS) {
            const weekEndText = $(el).find(".is-week-end-total span").text();
            const cumulativeText = $(el).find(".is-all-time-total span").text();
            weekEnd = parseMoney(weekEndText);
            cumulative = parseMoney(cumulativeText);

        } else {
            const weekEndText = $(el).find(".is-week-end-total span").text().replace(/\s|\$/g, "").replace(",", ".");
            const cumulativeText = $(el).find(".is-all-time-total span").text().replace(/\s|\$/g, "").replace(",", ".");
            weekEnd = parseFloat(weekEndText);
            cumulative = parseFloat(cumulativeText);
        }

        if (enTitle && weekEnd)
            map.set(enTitle, { weekEnd, cumulative, url: fullUrl, fr_title: title });
    });

    return map;
}