import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const DOC_GENRE = 99;

function norm(s=''){
    return s.normalize('NFD').replace(/\p{Diacritic}/gu,'')
        .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

// NEW: minimal separator variants (keeps your original title scoring untouched)
function titleVariants(title) {
    const t = (title || '').trim();
    const set = new Set([t]);
    set.add(t.replace(/\s*\|\s*/g, ' : '));
    set.add(t.replace(/\s*:\s*/g, ' | '));
    set.add(t.replace(/\s*[:|]\s*/g, ' - '));
    set.add(t.replace(/\s*[:|]\s*/g, ' '));
    return [...set].filter(Boolean);
}

export async function searchMovie(title, year, opts = {}) {
    const {
        language = 'fr-CA',
        region   = 'CA',
        tol      = 1,
        strict   = true,
        allowNoYearFallback = false,
    } = opts;

    const qn = norm(title);
    const yr = year ? +year : null;

    // inner runner: respects your year gating & scoring exactly
    const runOnce = async (q, { allowDocs=false }) => {
        const params = new URLSearchParams({
            api_key: process.env.TMDB_API_KEY,
            query: q,
            include_adult: 'false',
            language, region
        });
        if (year) params.set('year', String(year));

        const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
        const res = await fetch(url);
        const json = await res.json();
        let results = (json.results || []);

        // your year gate
        const within = (r) => {
            if (!yr) return true;
            const ry = +(r.release_date || '').slice(0,4) || null;
            if (ry == null) return !strict;
            return Math.abs(ry - yr) <= tol;
        };

        if (!allowDocs) results = results.filter(r => !(r.genre_ids||[]).includes(DOC_GENRE));
        results = results.filter(within);

        // your strict ±year probing (unchanged)
        if (strict && yr != null && results.length === 0) {
            for (const delta of [1, -1, 2, -2]) {
                const altParams = new URLSearchParams(params);
                altParams.set('year', String(yr + delta));
                const altRes = await fetch(`https://api.themoviedb.org/3/search/movie?${altParams}`);
                const altJson = await altRes.json();
                let alt = (altJson.results || []);
                if (!allowDocs) alt = alt.filter(r => !(r.genre_ids||[]).includes(DOC_GENRE));
                alt = alt.filter(r => Math.abs((+(r.release_date||'').slice(0,4)||0) - (yr+delta)) <= tol);
                if (alt.length) { results = alt; break; }
            }
        }

        // your scorer (unchanged)
        const score = (r) => {
            const tn = norm(r.title);
            const on = norm(r.original_title);
            const sTitle = (tn === qn || on === qn) ? 100 : (tn.includes(qn) || on.includes(qn)) ? 25 : 0;
            const ry = +(r.release_date || '').slice(0,4) || null;
            const sYear = yr != null && ry != null ? (Math.abs(ry-yr)===0?40: (Math.abs(ry-yr)<=1?20:0)) : 0;
            return sTitle + sYear + (r.popularity||0)/10;
        };
        results.sort((a,b)=>score(b)-score(a));

        return results;
    };

    // 1) try original + a couple separator variants (docs still excluded)
    for (const q of titleVariants(title)) {
        const res = await runOnce(q, { allowDocs:false });
        if (res.length) return res[0];
    }

    // 2) FINAL fallback: allow docs once (needed for the Swift “Release Party” event)
    for (const q of titleVariants(title)) {
        const res = await runOnce(q, { allowDocs:true });
        if (res.length) return res[0];
    }

    // 3) optional: your original allowNoYearFallback path (kept intact)
    if (allowNoYearFallback) {
        for (const q of titleVariants(title)) {
            const res = await runOnce(q, { allowDocs:true }); // keep docs allowed here too
            if (res.length) return res[0];
        }
    }

    return null;
}
