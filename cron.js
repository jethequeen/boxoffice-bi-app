import {insertMetadata} from "./insert/insertMetadata.js";
import {insertRevenue} from "./insert/insertRevenues.js";
import {extractBoxOfficeMap, getCinocheHtml} from "./scraper/cinoche.js";
import {searchMovie} from "./insert/searchMovie.js";

function getLastFriday() {
    const today = new Date();
    const day = today.getDay();
    const diff = (day >= 5) ? day - 5 : 7 - (5 - day);
    const friday = new Date(today);
    friday.setDate(today.getDate() - diff);
    return friday.toISOString().split("T")[0]; // Format: YYYY-MM-DD
}


const fridayDate = getLastFriday();
const html = await getCinocheHtml(fridayDate);
const qcMap = extractBoxOfficeMap(html, "box-office-qc-box-office");
const currentYear = new Date().getFullYear();

for (const [title, data] of qcMap.entries()) {
    const match = await searchMovie(title, currentYear);
    if (!match) {
        console.log(`⚠️ No TMDB match for ${title}`);
        continue;
    }
    const releaseYear = match.release_date?.split('-')[0]; // "2025"
    await insertMetadata(match.id); // ✅ Fait tout : movie + metadata
    await insertRevenue(match.id, releaseYear, fridayDate, data); // ✅ Ajoute le box-office

    console.log(`✓ ${title}: TMDB=${match.id}, QC=${data.weekEnd}, POS=${data.position}`);
}

