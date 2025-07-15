import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

export async function getCinocheHtml(date) {
    const url = `https://www.cinoche.com/films/box-office/${date}`;
    const res = await fetch(url);
    return await res.text();
}

export function extractBoxOfficeMap(html, sectionClass) {
    const $ = cheerio.load(html);
    const section = $(`.box-office-wrapper.${sectionClass}`);
    const rows = section.find("tr.table-row");

    const isUS = sectionClass.includes("murica");
    const map = new Map();

    rows.each((i, el) => {
        const title = $(el).find("h2.movie-title a").text().trim();
        const voMatch = $(el).find(".movie-infos").text().match(/\(([^()]+)\s+-\s+V\.O\.A\./);
        const enTitle = voMatch ? voMatch[1].trim() : title;
        const posText = $(el).find(".table-cell-position-text").text().trim();
        const position = parseInt(posText.replace("#", ""));
        const weekEndText = $(el).find(".is-week-end-total span").text().replace(/\s|\$/g, "");
        const weekEnd = parseFloat(weekEndText.replace(",", "."));

        if (enTitle && weekEnd)
            map.set(enTitle, { weekEnd, position });
    });

    return map;
}