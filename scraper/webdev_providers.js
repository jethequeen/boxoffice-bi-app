// scraper/webdev_providers.js
import { makeWebDevProvider, _internal } from "./billeterie_webdev_generique.js";

function normName(s=""){
    return String(s).normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase().replace(/\s+/g," ").trim();
}

const WEBDEV_BY_NAME = new Map();

function register(theaterNames, cfg){
    const provider = makeWebDevProvider(cfg);
    const names = Array.isArray(theaterNames) ? theaterNames : [theaterNames];
    for (const n of names) WEBDEV_BY_NAME.set(normName(n), provider);
}

/* ---------------------- Register each theater by name ---------------------- */

register(
    ["Maison du Cinéma (Sherbrooke)", "La Maison du Cinéma (Sherbrooke)", "Maison du Cinema"],
    {
        HORAIRE_URL:  "https://billets.lamaisonducinema.com/FR/horaire.awp?P1=01&P2=01",
        PURCHASE_URL: "https://billets.lamaisonducinema.com/FR/Film-achat.awp",
    }
);

// RGFM : No auditorium, No seats remaining :(
register(
["Cinéma RGFM Drummondville", "Cinema RGFM Drummondville"],
    {
        HORAIRE_URL: "https://billetterie.cinemasrgfm.com/FR/horaire.awp?P1=01&P2=02",
        PURCHASE_URL: "https://billetterie.cinemasrgfm.com/FR/Film-achat.awp",
        markerPattern: /id="zrl_(\d+)_(?:A8|A9)"/g,
        styleAnchors: ['margin-bottom:-1px'],
        locateExpand: 'row',
        hooks: {postCleanTitle: _internal.cleaners.cleanAggressiveTitle},
    }
)

// Cinéma Beaubien
register(
    ["Cinéma Beaubien", "Cinema Beaubien"],
    {
        HORAIRE_URL: "https://billetterie.cinemabeaubien.com/FR/horaire.awp?P1=01&P2=01",
        PURCHASE_URL: "https://billetterie.cinemabeaubien.com/FR/Film-achat.awp",
    }
);

// Cinéma du Parc / du Musée
register(
    ["Cinéma du Parc", "Cinema du Parc"],
    {
        HORAIRE_URL: "https://billetterie.cinemaduparc.com/FR/horaire.awp?P1=01&P2=02",
        PURCHASE_URL: "https://billetterie.cinemaduparc.com/FR/Film-achat.awp",
    }
);
register(
    ["Cinéma du Musée", "Cinema du Musee"],
    {
        HORAIRE_URL: "https://billetterie.cinemaduparc.com/FR/horaire.awp?P1=01&P2=03",
        PURCHASE_URL: "https://billetterie.cinemaduparc.com/FR/Film-achat.awp",
    }
);

// Azur Divertissements - No auditorium, No seats remaining :(
register(
    ["Cinéma Magog", "Cinema Magog"],
    {
        HORAIRE_URL:  "https://billetterie.azurdivertissements.com/FR/horaire.awp?P1=01&P2=03&P3",
        PURCHASE_URL: "https://billetterie.cinemaduparc.com/FR/Film-achat.awp",
    }
);

// Auditorium only
register(
    ["Cinéma Pine Sainte-Adèle", "Cinema Pine Sainte-Adele", "Cinéma Pine Ste-Adèle", "Cinema Pine"],
    {
        HORAIRE_URL:  "https://billetterie.cinemapine.com/FR/horaire.awp?P1=01&P2=01&P3=",
        PURCHASE_URL: "https://billetterie.cinemaduparc.com/FR/Film-achat.awp",
        markerPattern: /id="zrl_(\d+)_(?:A8|A9)"/g,
        styleAnchors: ["margin-bottom:-1px"],
        locateExpand: "row",
        hooks: { postCleanTitle: _internal.cleaners.cleanAggressiveTitle },
    }
);

    register(
        ["Cinéma Saint-Eustache", "Cinema Saint-Eustache"],
        {
            HORAIRE_URL:  "https://billetterie.cinemasteustache.ca/FR/horaire.awp?P1=01&P2=02&P3=",
            PURCHASE_URL: "https://billetterie.cinemasteustache.ca/FR/Film-achat.awp",
            markerPattern: /id="zrl_(\d+)_(?:A8|A9)"/g,
            styleAnchors: ["margin-bottom:-1px"],
            locateExpand: "row",
            hooks: { postCleanTitle: _internal.cleaners.cleanAggressiveTitle },
        }
    );


/* ------------------------------- Public API ------------------------------- */
export function findWebdevProviderByName(theaterName){
    return WEBDEV_BY_NAME.get(normName(theaterName)) || null;
}
export async function getSeatsByName(theaterName, { dateISO, hhmm, title }){
    const p = findWebdevProviderByName(theaterName);
    if (!p) throw new Error(`webdev: no provider configured for theater "${theaterName}"`);
    return p.getSeats({ dateISO, hhmm, title });
}
export function listWebdevTheaters(){
    // return display-style (denormalized) list for debugging
    return Array.from(WEBDEV_BY_NAME.keys()).sort();
}
