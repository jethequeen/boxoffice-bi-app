import {findWebdevProviderByName, getSeatsByName as getWebdevSeatsByName,} from "./webdev_providers.js";
import {cinemathequeScrapeSeats} from "../insert/seats_sold_Cinematheque_quebecoise.js";
import {scrapeSeatsOnly as cineplexScrapeSeats} from "../insert/insertAuditorium_cineplex.js";
import {getSeatCountsFromSchedule as cineEntrepriseSeats} from "../scraper/cineEntreprise_horaire_scraper.js";



/* ------------------------------- utils ------------------------------- */
function normName(s = "") {
    return String(s)
        .normalize("NFD").replace(/\p{Diacritic}/gu, "")
        .toLowerCase().replace(/\s+/g, " ").trim();
}
function addManyToSet(set, names) {
    for (const n of names) set.add(normName(n));
}

/* ------------------------ explicit Cineplex mapping ------------------------ */
const CINEPLEX_NAMES = new Set();

// Quebec (from your screenshot)
addManyToSet(CINEPLEX_NAMES, [
    "Cinéma Cineplex Odeon Quartier Latin",
    "Cinéma Banque Scotia",
    "Cinéma Cineplex Odeon Saint-Bruno",
    "Cinéma Cineplex Kirkland (Colisée)",
    "Cinéma Cineplex Odéon Beauport",
    "Cinéma Cineplex Laval",
    "Cinéma Capitol Saint-Jean",
    "Cinéma StarCité Montréal",
    "Cinéma Famous Players Carrefour Angrignon",
    "Cinéma Cineplex Royalmount",
    "Cinéma Cineplex Forum et VIP",
    "Cineplex IMAX aux Galeries de la Capitale",
    "Cinéma StarCité Gatineau",
    "Cinéma Cineplex Odeon Sainte-Foy",
    "Cinéma Galaxy Sherbrooke",
    "Cinéma Cineplex Odeon Carrefour Dorion",
    "Cinéma Cineplex Odeon Brossard et VIP",
    "Cinéma Galaxy Victoriaville",
]);
addManyToSet(CINEPLEX_NAMES, [
    "Cinema Cineplex Odeon Quartier Latin",
    "Cinema Banque Scotia",
    "Cinema Cineplex Odeon Saint-Bruno",
    "Cinema Cineplex Kirkland (Colisee)",
    "Cinema Cineplex Odeon Beauport",
    "Cinema Cineplex Laval",
    "Cinema Capitol Saint-Jean",
    "Cinema StarCite Montreal",
    "Cinema Famous Players Carrefour Angrignon",
    "Cinema Cineplex Royalmount",
    "Cinema Cineplex Forum et VIP",
    "Cineplex IMAX aux Galeries de la Capitale",
    "Cinema StarCite Gatineau",
    "Cinema Cineplex Odeon Sainte-Foy",
    "Cinema Galaxy Sherbrooke",
    "Cinema Cineplex Odeon Carrefour Dorion",
    "Cinema Cineplex Odeon Brossard et VIP",
    "Cinema Galaxy Victoriaville",
]);

export function isCineplexName(theaterName) {
    return CINEPLEX_NAMES.has(
        String(theaterName).normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase().replace(/\s+/g," ").trim()
    );
}

/* -------------------- Cine Entreprise mapping -------------------- */
const CINE_ENTREPRISE_MAP = new Map([
    // name in your DB                          // cinema slug (path segment)
    ["Cinéma Élysée (Granby)",                 "cinéma-élysée".replace(/\s+/g,'')], // -> "cinéma-élysée"
    ["Cinéma Odyssée",                         "cinéma-odyssée"],
    ["Cinéma Triomphe",                        "cinéma-triomphe"],
    ["Cinéma Du Cap",                          "cinéma-du-cap"],
    ["Cinéma Fleur de Lys",                    "cinéma-fleur-de-lys"],
    //  Pas de seats map ["Cinéma 9 Gatineau",  "cinéma-gatineau-9"],
    ["Cinéma Apéro Jonquière",                 "cinéma-jonquière"],
]);

const CINE_ENTREPRISE_INDEX = new Map();
for (const [name, slug] of CINE_ENTREPRISE_MAP) {
    CINE_ENTREPRISE_INDEX.set(normName(name), slug);
}
function findCineEntrepriseSlugByName(theaterName) {
    return CINE_ENTREPRISE_INDEX.get(normName(theaterName)) || null;
}



/* ------------------------- bucket detection by name ------------------------ */
export function classifyTheaterName(theaterName) {
    const n = normName(theaterName);

    if (findWebdevProviderByName(theaterName)) return "webdev";

    if (CINEPLEX_NAMES.has(n)) return "cineplex";

    if (/\bcinematheque\b|cinémath[eè]que/i.test(n)) return "cinematheque";

    if (findCineEntrepriseSlugByName(theaterName)) return "cineentreprise";

    // very last-resort fallback (kept for safety, but explicit set should catch real cases)
    if (/\bcineplex\b/i.test(n)) return "cineplex";

    return null;
}

/* ------------------------------ public API ------------------------------ */
export async function getSeatsByTheater(theaterName, { dateISO, hhmm, title }, context = {}) {
    const kind = classifyTheaterName(theaterName);

    if (kind === "webdev") {
        return getWebdevSeatsByName(theaterName, { dateISO, hhmm, title });
    }

    if (kind === "cinematheque") {
        return cinemathequeScrapeSeats({ dateISO, hhmm, title });
    }

    if (kind === "cineplex") {
        const { locationId, showtimesKey, movieTitle } = context;
        if (!locationId || !showtimesKey) {
            throw new Error("cineplex: missing { locationId, showtimesKey } in context");
        }
        return cineplexScrapeSeats({
            movieTitle: movieTitle ?? title,
            local_date: dateISO,
            local_time: hhmm,
            locationId,
            showtimesKey,
        });
    }

    if (kind === "cineentreprise") {
        const slug = findCineEntrepriseSlugByName(theaterName);
        if (!slug) throw new Error(`cineentreprise: no slug for "${theaterName}"`);
        const dayLabel = dateISO
            ? (() => {
                const d = new Date(dateISO);
                return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
            })()
            : null;

        return await cineEntrepriseSeats(
            slug,               // cinemaSlug
            theaterName,        // theater (for reporting)
            title,              // movieTitle (visible on card)
            dayLabel,           // date label (not required today)
            hhmm,               // time
            context.playwright  // optional { launch, ... } passthrough
        );
    }

    throw new Error(`No provider mapping for "${theaterName}".`);
}
