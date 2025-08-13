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
        const posText = $(el).find(".table-cell-position-text").text().trim();
        const position = parseInt(posText.replace("#", ""));

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
            map.set(enTitle, { weekEnd, cumulative, position, url: fullUrl, fr_title: title });
    });

    return map;
}


export async function getTheaterCountFromCinocheUrl(baseUrl) {
    try {
        const horairesUrl = baseUrl.endsWith('/') ? `${baseUrl}horaires` : `${baseUrl}/horaires`;
        const res = await fetch(horairesUrl);
        const html = await res.text();

        const startIndex = html.indexOf('<div class="theaters-items">');

        let depth = 0;
        let endIndex = startIndex;
        const remainingHtml = html.substring(startIndex);
        const divRegex = /<\/?div\b[^>]*>/gi;
        let match;

        while ((match = divRegex.exec(remainingHtml)) !== null) {
            if (match[0].startsWith("</")) {
                depth--;
            } else {
                depth++;
            }
            if (depth === 0) {
                endIndex = startIndex + match.index + match[0].length;
                break;
            }
        }

        const theaterBlock = html.substring(startIndex, endIndex);
        const matches = theaterBlock.match(/<div[^>]+class="[^"]*\btheater-item\b[^"]*"/g);
        return matches ? matches.length : 0;
    } catch (e) {
        console.error(`❌ Erreur lors du comptage des cinémas pour ${baseUrl}:`, e);
        return 0;
    }
}

