import fetch from "node-fetch";
import * as cheerio from "cheerio";

const COMING_SOON_BASE = "https://www.cinoche.com/films/a-venir";

/**
 * Fetch HTML from a URL
 */
async function fetchHtml(url) {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

/**
 * Convert French month name to month number (01-12)
 */
function frenchMonthToNumber(monthName) {
    const months = {
        'janvier': '01', 'février': '02', 'fevrier': '02',
        'mars': '03', 'avril': '04', 'mai': '05', 'juin': '06',
        'juillet': '07', 'août': '08', 'aout': '08',
        'septembre': '09', 'octobre': '10', 'novembre': '11',
        'décembre': '12', 'decembre': '12'
    };
    return months[monthName.toLowerCase()] || null;
}

/**
 * Parse release date from French text like "Sortie partout au Québec : 14 novembre 2025"
 * Returns YYYY-MM-DD format or null
 */
function parseReleaseDateFromText(text) {
    if (!text) return null;

    // Pattern: day month year (e.g., "14 novembre 2025")
    const match = text.match(/(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i);

    if (match) {
        const day = match[1].padStart(2, '0');
        const month = frenchMonthToNumber(match[2]);
        const year = match[3];

        if (month) {
            return `${year}-${month}-${day}`;
        }
    }

    return null;
}

/**
 * Parse movies from a coming soon page (specific month or general)
 * Returns: [{ title, href, releaseDate }]
 */
function parseMoviesFromComingSoon(html) {
    const $ = cheerio.load(html);
    const movies = [];

    // Look for movie elements in the dropdown menu or listings
    // Based on the HTML structure, movies have data-release-date attribute
    $('[data-release-date]').each((_, el) => {
        const $el = $(el);
        const releaseDate = $el.attr('data-release-date');
        const name = $el.attr('data-name');

        // Try to find the link
        const $link = $el.find('a.movies-element-link, a.dropdown-content-movies-element-link').first();
        if (!$link.length) return;

        const href = $link.attr('href');
        if (!href) return;

        // Get title - prefer data-name, then extract from link
        let title = name || $link.find('h3').text().trim() || $link.attr('title')?.trim();

        if (!title) return;

        const fullUrl = href.startsWith('http') ? href : `https://www.cinoche.com${href}`;

        movies.push({
            title: title,
            href: fullUrl,
            releaseDate: releaseDate || null
        });
    });

    // Also look for movies in the main content area with different structure
    $('a[href^="/films/"]').each((_, a) => {
        const $a = $(a);
        const href = $a.attr('href');
        if (!href || !/^\/films\/[^/]+$/.test(href)) return;

        const fullUrl = `https://www.cinoche.com${href}`;

        // Skip if we already have this movie
        if (movies.some(m => m.href === fullUrl)) return;

        const title = $a.attr('title')?.trim() ||
                      $a.find('img[alt]').attr('alt')?.trim() ||
                      $a.text().trim();

        if (!title) return;

        // Try to find release date nearby
        let releaseDate = null;
        const $parent = $a.closest('[data-release-date]');
        if ($parent.length) {
            releaseDate = $parent.attr('data-release-date');
        }

        movies.push({
            title,
            href: fullUrl,
            releaseDate
        });
    });

    // Remove duplicates by href
    const uniqueMovies = new Map();
    for (const movie of movies) {
        if (!uniqueMovies.has(movie.href)) {
            uniqueMovies.set(movie.href, movie);
        }
    }

    return Array.from(uniqueMovies.values());
}

/**
 * Get all available future month URLs from the coming soon page
 * Returns: ['2025-11', '2025-12', '2026-01', ...]
 */
export async function getAvailableMonths() {
    try {
        const html = await fetchHtml(COMING_SOON_BASE);
        const $ = cheerio.load(html);
        const months = new Set();

        // Look for month links - they might be in a selector or navigation
        $('a[href*="/films/a-venir/"]').each((_, el) => {
            const href = $(el).attr('href');
            const match = href?.match(/\/films\/a-venir\/(\d{4}-\d{2})/);
            if (match) {
                months.add(match[1]);
            }
        });

        // Also check for any data attributes or buttons with month info
        $('[data-month], [data-date]').each((_, el) => {
            const month = $(el).attr('data-month') || $(el).attr('data-date');
            if (month && /^\d{4}-\d{2}$/.test(month)) {
                months.add(month);
            }
        });

        return Array.from(months).sort();
    } catch (error) {
        console.error('Error fetching available months:', error);
        return [];
    }
}

/**
 * Get movies from a specific month
 * @param {string} yearMonth - Format: 'YYYY-MM' (e.g., '2025-11')
 * @returns {Promise<Array>} - Array of { title, href, releaseDate }
 */
export async function getMoviesForMonth(yearMonth) {
    const url = `${COMING_SOON_BASE}/${yearMonth}`;
    console.log(`Fetching movies for ${yearMonth} from ${url}`);

    try {
        const html = await fetchHtml(url);
        const movies = parseMoviesFromComingSoon(html);
        console.log(`Found ${movies.length} movies for ${yearMonth}`);
        return movies;
    } catch (error) {
        console.error(`Error fetching movies for ${yearMonth}:`, error.message);
        return [];
    }
}

/**
 * Get movies for current month and next month
 */
export async function getCurrentAndNextMonthMovies() {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const nextMonthDate = new Date(now);
    nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
    const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}`;

    console.log(`Fetching movies for current month (${currentMonth}) and next month (${nextMonth})`);

    const [currentMovies, nextMovies] = await Promise.all([
        getMoviesForMonth(currentMonth),
        getMoviesForMonth(nextMonth)
    ]);

    // Merge and deduplicate
    const allMovies = new Map();
    for (const movie of [...currentMovies, ...nextMovies]) {
        if (!allMovies.has(movie.href)) {
            allMovies.set(movie.href, movie);
        }
    }

    return Array.from(allMovies.values());
}

/**
 * Get all future movies beyond next month
 */
export async function getFutureMonthsMovies() {
    const now = new Date();
    const nextMonthDate = new Date(now);
    nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
    const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}`;

    // Get all available months
    const allMonths = await getAvailableMonths();

    // Filter to only months after next month
    const futureMonths = allMonths.filter(month => month > nextMonth);

    // If no months found via the page, generate next 6 months manually
    if (futureMonths.length === 0) {
        console.log('No months found on page, generating next 6 months manually');
        const generated = [];
        const startDate = new Date(nextMonthDate);
        startDate.setMonth(startDate.getMonth() + 1);

        for (let i = 0; i < 6; i++) {
            const month = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;
            generated.push(month);
            startDate.setMonth(startDate.getMonth() + 1);
        }
        futureMonths.push(...generated);
    }

    console.log(`Fetching movies for future months: ${futureMonths.join(', ')}`);

    // Fetch all future months
    const allMoviesArrays = await Promise.all(
        futureMonths.map(month => getMoviesForMonth(month))
    );

    // Flatten and deduplicate
    const allMovies = new Map();
    for (const movies of allMoviesArrays) {
        for (const movie of movies) {
            if (!allMovies.has(movie.href)) {
                allMovies.set(movie.href, movie);
            }
        }
    }

    return Array.from(allMovies.values());
}
