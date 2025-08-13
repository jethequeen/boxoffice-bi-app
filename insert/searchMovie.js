import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const DOC_GENRE = 99;

function norm(s = '') {
    return s
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\bfour\b/g, '4').replace(/\bquatre\b/g, '4')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

export async function searchMovie(title, year, opts = {}) {
    const params = new URLSearchParams({
        api_key: process.env.TMDB_API_KEY,
        query: title,
        include_adult: 'false',
        language: opts.language || 'fr-CA',
        region: opts.region || 'CA'
    });
    if (year) params.set('year', String(year));

    const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
    const res = await fetch(url);
    const json = await res.json();

    let results = (json.results || []).filter(r => !(r.genre_ids || []).includes(DOC_GENRE));

    const qn = norm(title);
    const score = (r) => {
        const tn = norm(r.title);
        const on = norm(r.original_title);
        const ry = (r.release_date || '').slice(0, 4);
        let s = 0;
        if (tn === qn || on === qn) s += 100;              // exact normalized match
        if (tn.includes(qn) || on.includes(qn)) s += 25;   // partial match
        if (year) {
            if (ry === String(year)) s += 40;
            else if (Math.abs((+ry || 0) - year) <= 1) s += 15;
        }
        s += (r.popularity || 0) / 10;                     // tiebreaker
        return s;
    };
    results.sort((a, b) => score(b) - score(a));

    return results[0] || null;
}
