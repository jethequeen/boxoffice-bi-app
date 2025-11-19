import fetch from "node-fetch";
import * as cheerio from "cheerio";

/**
 * Fetch the release date from a Cinoche film page.
 * The release date is in div.movie-schedule > div.movie-schedule-left-content > span.movie-schedule-next
 * with text like "Sortie partout au Québec : 14 novembre 2025"
 *
 * @param {string} baseFilmUrl - The URL of the Cinoche movie page
 * @returns {Promise<string|null>} - The release date in YYYY-MM-DD format, or null if not found
 */
export async function fetchReleaseDateFromCinoche(baseFilmUrl) {
    try {
        const res = await fetch(baseFilmUrl, { headers: { "user-agent": "Mozilla/5.0" } });
        if (!res.ok) {
            console.warn(`Failed to fetch Cinoche page: ${res.status}`);
            return null;
        }

        const html = await res.text();
        const $ = cheerio.load(html);

        // Primary method: Look in div.movie-schedule for span.movie-schedule-next
        // that contains "Sortie" followed by a date
        const scheduleDivs = $('.movie-schedule').toArray();
        for (const scheduleDiv of scheduleDivs) {
            const $scheduleDiv = $(scheduleDiv);
            const scheduleText = $scheduleDiv.find('.movie-schedule-next').text();

            // Look for "Sortie" pattern with date
            const sortiePattern = /sortie.*?(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i;
            const match = scheduleText.match(sortiePattern);

            if (match) {
                const day = match[1].padStart(2, '0');
                const month = frenchMonthToNumber(match[2]);
                const year = match[3];

                if (month) {
                    const releaseDate = `${year}-${month}-${day}`;
                    console.log(`Found release date from movie-schedule: ${releaseDate}`);
                    return releaseDate;
                }
            }
        }

        // Fallback method: Look for data-release-date attribute
        const dataReleaseDate = $('[data-release-date]').first().attr('data-release-date');
        if (dataReleaseDate && /^\d{4}-\d{2}-\d{2}$/.test(dataReleaseDate)) {
            console.log(`Found release date from data-release-date: ${dataReleaseDate}`);
            return dataReleaseDate;
        }

        // Last resort: Search entire body for "Sortie" pattern
        const bodyText = $('body').text();
        const sortiePattern = /sortie.*?(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i;
        const sortieMatch = bodyText.match(sortiePattern);

        if (sortieMatch) {
            const day = sortieMatch[1].padStart(2, '0');
            const month = frenchMonthToNumber(sortieMatch[2]);
            const year = sortieMatch[3];

            if (month) {
                const releaseDate = `${year}-${month}-${day}`;
                console.log(`Found release date from body text: ${releaseDate}`);
                return releaseDate;
            }
        }

        console.warn(`No release date found on Cinoche page: ${baseFilmUrl}`);
        return null;

    } catch (error) {
        console.error(`Error fetching release date from Cinoche: ${error.message}`);
        return null;
    }
}

/**
 * Convert French month name to two-digit month number
 */
function frenchMonthToNumber(monthName) {
    const months = {
        'janvier': '01',
        'février': '02',
        'fevrier': '02',
        'mars': '03',
        'avril': '04',
        'mai': '05',
        'juin': '06',
        'juillet': '07',
        'août': '08',
        'aout': '08',
        'septembre': '09',
        'octobre': '10',
        'novembre': '11',
        'décembre': '12',
        'decembre': '12'
    };

    return months[monthName.toLowerCase()] || null;
}
