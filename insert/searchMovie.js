import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const DOC_GENRE = 99;

function norm(s=''){
    return s.normalize('NFD').replace(/\p{Diacritic}/gu,'')
        .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

export async function searchMovie(title, year, opts = {}) {
    const {
        language = 'fr-CA',
        region   = 'CA',
        tol      = 1,        // allowed |release_year - year|
        strict   = true,     // if true, reject results outside tol
        allowNoYearFallback = false, // don’t query without year unless you say so
    } = opts;

    const params = new URLSearchParams({
        api_key: process.env.TMDB_API_KEY,
        query: title,
        include_adult: 'false',
        language, region
    });
    if (year) params.set('year', String(year));

    const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
    const res = await fetch(url);
    const json = await res.json();
    let results = (json.results || []).filter(r => !(r.genre_ids||[]).includes(DOC_GENRE));

    const qn = norm(title);
    const yr = year ? +year : null;

    // year gate first
    const within = (r) => {
        if (!yr) return true;
        const ry = +(r.release_date || '').slice(0,4) || null;
        if (ry == null) return !strict;        // drop if strict
        return Math.abs(ry - yr) <= tol;
    };
    results = results.filter(within);

    // if strict and none matched, optionally try ±1 year
    if (strict && yr != null && results.length === 0) {
        for (const delta of [1, -1, 2, -2]) {
            const altParams = new URLSearchParams(params);
            altParams.set('year', String(yr + delta));
            const altRes = await fetch(`https://api.themoviedb.org/3/search/movie?${altParams}`);
            const altJson = await altRes.json();
            let alt = (altJson.results || []).filter(r => !(r.genre_ids||[]).includes(DOC_GENRE));
            alt = alt.filter(r => Math.abs((+(r.release_date||'').slice(0,4)||0) - (yr+delta)) <= tol);
            if (alt.length) { results = alt; break; }
        }
    }

    // score (after year filter)
    const score = (r) => {
        const tn = norm(r.title);
        const on = norm(r.original_title);
        const sTitle = (tn === qn || on === qn) ? 100 : (tn.includes(qn) || on.includes(qn)) ? 25 : 0;
        const ry = +(r.release_date || '').slice(0,4) || null;
        const sYear = yr != null && ry != null ? (Math.abs(ry-yr)===0?40: (Math.abs(ry-yr)<=1?20:0)) : 0;
        return sTitle + sYear + (r.popularity||0)/10;
    };
    results.sort((a,b)=>score(b)-score(a));

    if (!results.length && allowNoYearFallback) {
        return await searchMovie(title, undefined,
            { language, region, tol, strict:false, allowNoYearFallback:false });
    }
    return results[0] || null;
}
