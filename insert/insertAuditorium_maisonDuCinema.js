// insert/insertAuditorium_maisonDuCinema.js
// ESM. Usage:
// node insert/insertAuditorium_maisonDuCinema.js "https://lamaisonducinema.com/films/" [--out out.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadCheerio } from "cheerio";

const TIME_RE = /\b(0?\d|1\d|2[0-3]):(\d{2})\b/i;
const SALLE_RE = /\b(salle|auditorium)\s*#?\s*([a-z0-9]+)\b/i;

const HORAIRE_URL = "https://lamaisonducinema.com/films/"


    if (isMain(import.meta.url)) {
    const [src] = process.argv.slice(2);
    if (!src) {
        console.error('Usage: node insert/insertAuditorium_maisonDuCinema.js "<URL or file.html>" [--out out.json]');
        process.exit(1);
    }
    const outIdx = process.argv.indexOf("--out");
    const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;

    extractFromMaisonDuCinema(src)
        .then(data => {
            console.log(JSON.stringify(data, null, 2));
            if (outPath) {
                fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
                console.log("✓ wrote", path.resolve(outPath));
            }
        })
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

export async function extractFromMaisonDuCinema(source) {
    const html = await loadSource(source);
    const $ = loadCheerio(html);

    /** @type {Record<string, Record<string, Array<{time:string,salle:string|null}>>>} */
    const result = Object.create(null);

    // Only loop over movie cards.
    $(".list-item").each((_, card) => {
        const $card = $(card);

        // Movie title (first h2 inside the card)
        const title = clean($card.find("h2").first().text());
        if (!title) return;

        // Each grid holds one date (ISO string in data-date)
        $card.find(".schedule-day-grid").each((__, grid) => {
            const $grid = $(grid);
            const dateISO = $grid.attr("data-date");
            if (!dateISO) return;

            // Real showtimes are the <a> links in the “show_col_2” column
            $grid.find(".show_col_2 a").each((___, a) => {
                const $a = $(a);
                const tRaw = clean($a.find(".hour").first().text());
                const sRaw = clean($a.find(".salle").first().text());

                const tm = tRaw.match(TIME_RE);
                if (!tm) return;
                const time = `${tm[1].padStart(2, "0")}:${tm[2]}`;

                let salle = null;
                if (sRaw) {
                    const sm = sRaw.match(SALLE_RE);
                    salle = sm ? normalizeSalle(sm[1], sm[2]) : sRaw;
                }

                put(result, title, dateISO, time, salle);
            });
        });
    });

    return result;
}

// ---------- helpers ----------
async function loadSource(src) {
    if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src, {
            headers: { "user-agent": ua() },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${src}`);
        return await res.text();
    }
    return fs.readFileSync(src, "utf8");
}

function put(store, movie, dateISO, time, salle) {
    store[movie] ??= Object.create(null);
    store[movie][dateISO] ??= [];
    const exists = store[movie][dateISO].some(x => x.time === time && x.salle === salle);
    if (!exists) store[movie][dateISO].push({ time, salle });
}

function clean(s) {
    return (s || "").replace(/\s+/g, " ").replace(/&nbsp;/gi, " ").trim();
}
function normalizeSalle(word, num) {
    const w = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    return `${w} ${String(num)}`.trim();
}
function ua() {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
}
function isMain(moduleUrl) {
    const __filename = fileURLToPath(moduleUrl);
    return path.resolve(process.argv[1] || "") === __filename;
}
