// scraper/webdev_providers.js
import { makeWebDevProvider, _internal } from "./billeterie_webdev_generique.js";
import { createGenericNoSeatsProvider } from "./webdev_generic_schedule.js";

function normName(s=""){
    return String(s).normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase().replace(/\s+/g," ").trim();
}
const WEBDEV_BY_NAME = new Map();

function normType(t) {
    const x = String(t || "displayingSeats").toLowerCase().replace(/\s|[_-]/g, "");
    if (["noseat","noseats","notdisplayingseats"].includes(x)) return "notDisplayingSeats";
    return "displayingSeats";
}

function ensureBase(cfg){
    if (cfg.BASE) return cfg;
    const u = new URL(cfg.HORAIRE_URL);
    return { ...cfg, BASE: u.origin };
}

function register(theaterNames, cfg) {
    const names = Array.isArray(theaterNames) ? theaterNames : [theaterNames];
    const type  = normType(cfg.type);
    const full  = ensureBase(cfg);

    // Build both implementations
    const lister       = createGenericNoSeatsProvider(full);                 // has getSchedule, getSeats (probe), probeCapacityCandidate, createPurchaseSession
    const seatProvider = (type === "displayingSeats") ? makeWebDevProvider(full) : null;

    const provider = {
        kind: type,

        // schedules: prefer the lister (works for both), fallback to seatProvider if ever added there
        async getSchedule(args) {
            if (lister && typeof lister.getSchedule === "function") return lister.getSchedule(args);
            if (seatProvider && typeof seatProvider.getSchedule === "function") return seatProvider.getSchedule(args);
            throw new Error(`webdev: schedule listing not supported for this provider.`);
        },

        // seats:
        async getSeats(args) {
            if (type === "displayingSeats") {
                if (!seatProvider || typeof seatProvider.getSeats !== "function") {
                    throw new Error(`webdev: "${type}" provider is missing getSeats() implementation`);
                }
                return seatProvider.getSeats(args);  // seat-map flow
            }
            // notDisplayingSeats → lister’s probe flow (expects showUrl)
            if (lister && typeof lister.getSeats === "function") return lister.getSeats(args);
            throw new Error(`webdev: "${type}" provider is missing probe getSeats() implementation`);
        },

        // ✅ pass-through the new methods from the lister so cron can call them
        probeCapacityCandidate: (lister && typeof lister.probeCapacityCandidate === "function")
            ? lister.probeCapacityCandidate
            : undefined,

        createPurchaseSession: (lister && typeof lister.createPurchaseSession === "function")
            ? lister.createPurchaseSession
            : undefined,
    };

    for (const n of names) WEBDEV_BY_NAME.set(normName(n), provider);
}


/* ---------------------- With Seats ---------------------- */

register(
    ["Maison du Cinéma (Sherbrooke)", "La Maison du Cinéma (Sherbrooke)", "Maison du Cinema"],
    {
        type: "displayingSeats",
        HORAIRE_URL:  "https://billets.lamaisonducinema.com/FR/horaire.awp?P1=01&P2=01",
        PURCHASE_URL: "https://billets.lamaisonducinema.com/FR/Film-achat.awp",
    }
);

// Cinéma Beaubien
register(
    ["Cinéma Beaubien", "Cinema Beaubien"],
    {
        type: "displayingSeats",
        HORAIRE_URL: "https://billetterie.cinemabeaubien.com/FR/horaire.awp?P1=01&P2=01",
        PURCHASE_URL: "https://billetterie.cinemabeaubien.com/FR/Film-achat.awp",
    }
);

// Cinéma du Parc / du Musée
register(
    ["Cinéma du Parc", "Cinema du Parc"],
    {
        type: "displayingSeats",
        HORAIRE_URL: "https://billetterie.cinemaduparc.com/FR/horaire.awp?P1=01&P2=02",
        PURCHASE_URL: "https://billetterie.cinemaduparc.com/FR/Film-achat.awp",
    }
);
register(
    ["Cinéma du Musée", "Cinema du Musee"],
    {
        type: "displayingSeats",
        HORAIRE_URL: "https://billetterie.cinemaduparc.com/FR/horaire.awp?P1=01&P2=03",
        PURCHASE_URL: "https://billetterie.cinemaduparc.com/FR/Film-achat.awp",
    }
);

register(
    ["Cinéma Saint-Eustache", "Cinema Saint-Eustache"],
    {
        type: "displayingSeats",
        HORAIRE_URL:  "https://billetterie.cinemasteustache.ca/FR/horaire.awp?P1=01&P2=02&P3=",
        PURCHASE_URL: "https://billetterie.cinemasteustache.ca/FR/Film-achat.awp",
        markerPattern: /id="zrl_(\d+)_(?:A8|A9)"/g,
        styleAnchors: ["margin-bottom:-1px"],
        locateExpand: "row",
        hooks: { postCleanTitle: _internal.cleaners.cleanAggressiveTitle },
        }
    );


/* ---------------------- Without Seats ---------------------- */

register(["Cinéma RGFM Drummondville"], {
    type: "notDisplayingSeats",
    HORAIRE_URL:  "https://billetterie.cinemasrgfm.com/FR/horaire.awp?P1=01&P2=03",
    PURCHASE_URL: "https://billetterie.cinemasrgfm.com/FR/Film-achat.awp",
    BASE:         "https://billetterie.cinemasrgfm.com",
    hooks: { postCleanTitle: _internal?.cleaners?.cleanAggressiveTitle },
});

register(["Cinéma RGFM Beloeil"], {
    type: "notDisplayingSeats",
    HORAIRE_URL:  "https://billetterie.cinemasrgfm.com/FR/horaire.awp?P1=01&P2=02",
    PURCHASE_URL: "https://billetterie.cinemasrgfm.com/FR/Film-achat.awp",
    BASE:         "https://billetterie.cinemasrgfm.com",
    hooks: { postCleanTitle: _internal?.cleaners?.cleanAggressiveTitle },
});

register(["Cinéma Magog"], {
    type: "notDisplayingSeats",
    HORAIRE_URL:  "https://billetterie.azurdivertissements.com/FR/horaire.awp?P1=01&P2=03",
    PURCHASE_URL: "https://billetterie.azurdivertissements.com/FR/Film-achat.awp",
    BASE:         "https://billetterie.azurdivertissements.com",
    selectors: {
        titleCandidates: (row) => [
            `#tzzrl_${row}_A12`,
            `#zrl_${row}_A37`,
            `[id^="zrl_${row}_A"]`,
        ],
        hiddenKeySelectors: (row, a) => [
            `#tzzrl_${row}_A${a}`,
            `#zrl_${row}_A${a}`,
        ],
    },
    hooks: { postCleanTitle: _internal?.cleaners?.cleanAggressiveTitle },
});

register(["Cinéma Pine Sainte-Adèle"], {
    type: "notDisplayingSeats",
    HORAIRE_URL:  "https://billetterie.cinemapine.com/FR/horaire.awp?P1=01&P2=01&P3=",
    PURCHASE_URL: "https://billetterie.cinemapine.com/FR/Film-achat.awp",
    BASE:         "https://billetterie.cinemapine.com",
    hooks: { postCleanTitle: _internal?.cleaners?.cleanAggressiveTitle },
});


/* ----------------------------- Public API ----------------------------- */
export function findWebdevProviderByName(theaterName){
    return WEBDEV_BY_NAME.get(normName(theaterName)) || null;
}

export async function getScheduleByName(theaterName, { dateISO, dump=false }){
    const p = findWebdevProviderByName(theaterName);
    if (!p) throw new Error(`webdev: no provider configured for "${theaterName}"`);
    if (typeof p.getSchedule !== "function") {
        throw new Error(`webdev: "${theaterName}" is a seat-flow site; use getSeats()`);
    }
    return p.getSchedule({ dateISO, dump });
}
export async function getSeatsByName(theaterName, args){
    const p = findWebdevProviderByName(theaterName);
    if (!p) throw new Error(`webdev: no provider configured for "${theaterName}"`);
    if (typeof p.getSeats !== "function") {
        throw new Error(`webdev: "${theaterName}" is a no-seat site; use getSchedule()`);
    }
    return p.getSeats(args);
}

export function listWebdevTheaters(){
    return Array.from(WEBDEV_BY_NAME.keys()).sort();
}