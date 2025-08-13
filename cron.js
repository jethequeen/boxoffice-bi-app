import {insertMetadata} from "./insert/insertMetadata.js";
import {insertRevenue, updateCumulatives} from "./insert/insertRevenues.js";
import {extractBoxOfficeMap, getCinocheHtml, getTheaterCountFromCinocheUrl} from "./scraper/cinoche.js";
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
    const theaterCount = await getTheaterCountFromCinocheUrl(qcData.url);

    await insertRevenue(tmdbId, releaseYear, fridayDate, {
        weekEnd: qcData.weekEnd,
        position: qcData.position,
    }, theaterCount, usData);

    await updateCumulatives(tmdbId, {
        qc: qcData.cumulative ?? null,
        us: usData?.cumulative ?? null,
    });

    console.log(`✓ ${title}: TMDB=${tmdbId}, QC=${qcData.weekEnd}, POS=${qcData.position}, US=${usData?.weekEnd ?? "—"}`);



}

