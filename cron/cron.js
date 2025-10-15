import {insertMetadata} from "../insert/insertMetadata.js";
import {insertRevenue, getWeekendId_YYYYWW, addDaysISO} from "../insert/insertRevenues.js";
import {extractBoxOfficeMap, getCinocheHtml} from "../scraper/cinoche.js";
import {searchMovie} from "../insert/searchMovie.js";
import { insertWeekendEstimates } from '../insert/insertWeekendEstimates.js';

function getLastFriday() {
    const today = new Date();
    const day = today.getDay();
    const diff = (day >= 5) ? day - 5 : 7 - (5 - day);
    const friday = new Date(today);
    friday.setDate(today.getDate() - diff);
    return friday.toISOString().split("T")[0]; // Format: YYYY-MM-DD
}


const fridayDate = getLastFriday();
console.log(fridayDate);
const html = await getCinocheHtml(fridayDate);
const qcMap = extractBoxOfficeMap(html, "box-office-qc-box-office");
const currentYear = new Date().getFullYear();
const usMap = extractBoxOfficeMap(html, "box-office-murica-box-office");

for (const [title, qcData] of qcMap.entries()) {
    const match = await searchMovie(title, currentYear);
    if (!match) {
        console.log(`⚠️ No TMDB match for ${title}`);
        continue;
    }

    const tmdbId = match.id;
    const releaseYear = match.release_date?.split('-')[0];
    const usData = usMap.get(title);

    await insertMetadata(tmdbId, qcData.fr_title);

    await insertRevenue(tmdbId, releaseYear, fridayDate, {
        weekEnd: qcData.weekEnd,
        cumulative: qcData.cumulative,
    }, usData);
}

const endISO    = addDaysISO(fridayDate, 2);
const weekendId = getWeekendId_YYYYWW(endISO);
console.log(weekendId)

// $14 default; change if you want to pass a param
await insertWeekendEstimates(weekendId, 13, 0.9);

// also compute next weekend so Thursday previews show up there
const fridayNext   = addDaysISO(fridayDate, 7);
const weekendNext  = getWeekendId_YYYYWW(addDaysISO(fridayNext, 2));
await insertWeekendEstimates(weekendNext, 13, 0.92);




