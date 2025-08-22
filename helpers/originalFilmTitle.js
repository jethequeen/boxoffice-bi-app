import fetch from "node-fetch";
import * as cheerio from "cheerio";

/**
 * Extract the "original title" from a Cinoche film page.
 * Targets explicit labels first, then header patterns, then JSON-LD.
 * Avoids venue/theater strings (e.g., "Théâtre Desjardins").
 */
export async function fetchOriginalTitleFromCinoche(baseFilmUrl) {
    const res = await fetch(baseFilmUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // 1) Label: "Titre original : ..."
    // Try common “key: value” patterns in info blocks.
    // Look for any element containing the label, then read its sibling/inline value.
    const labelSelectors = [
        '.movie-infos', '.movie-details', '.movie-data', '.movie-credits',
        '.content', '.sidebar', 'main'
    ];
    for (const sel of labelSelectors) {
        const $scope = $(sel);
        if (!$scope.length) continue;

        // a) direct inline: "Titre original : Foo Bar"
        const inline = $scope.text().match(/Titre\s+original\s*:?\s*([^\n\r|•<]{2,120})/i);
        if (inline?.[1]) {
            const t = sanitizeCandidate(inline[1]);
            if (t) return t;
        }

        // b) dt/dd or two-column rows: <dt>Titre original</dt><dd>Foo Bar</dd>
        const dt = $scope.find('dt:contains("Titre original"), .label:contains("Titre original")').first();
        if (dt.length) {
            const dd = dt.next('dd, .value');
            const v = sanitizeCandidate(dd.text());
            if (v) return v;
        }

        // c) table rows: <tr><th>Titre original</th><td>Foo Bar</td></tr>
        const tr = $scope.find('tr').filter((_, el) =>
            /Titre\s+original/i.test($(el).text())
        ).first();
        if (tr.length) {
            const v = sanitizeCandidate(tr.find('td, .value').text());
            if (v) return v;
        }
    }

    // 2) Header pattern: "(Original Title) - V.O.A. ..."
    const header = $('.movie-infos, .movie-header, .movie-subtitle, header, h1, h2').first().text();
    const mVoa = header.match(/\(([^()]+?)\s*-\s*V\.?O\.?A\.?(?:[^)]*)\)/i);
    if (mVoa?.[1]) {
        const t = sanitizeCandidate(mVoa[1]);
        if (t) return t;
    }

    // 3) JSON-LD fallback: look for Movie.alternateName
    let jsonCandidate = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const txt = $(el).contents().text();
            const data = JSON.parse(txt);
            const nodes = Array.isArray(data) ? data : [data];
            for (const n of nodes) {
                if (n && (n['@type'] === 'Movie' || n['@type'] === 'CreativeWork')) {
                    const alt = sanitizeCandidate(n.alternateName || "");
                    if (alt) { jsonCandidate = alt; return false; }
                }
            }
        } catch { /* ignore */ }
    });
    if (jsonCandidate) return jsonCandidate;

    return null;
}

function sanitizeCandidate(s) {
    if (!s) return null;
    let t = s.replace(/\s+/g, ' ').trim();
    // Strip trailing separators or labels that leak in
    t = t.replace(/^(de|par)\s+/i, '').replace(/\s+[•|].*$/, '').trim();

    // Discard obvious non-titles (venues/formats)
    const BAD = /(th[eé]âtre|cin[eé]|rgfm|guzzo|beaubien|forum|imax|vip|4d|d-box)/i;
    if (BAD.test(t)) return null;

    // Too short/long? Probably noise.
    if (t.length < 2 || t.length > 120) return null;

    return t;
}

/**
 * Returns an array of candidate titles from a Cinoche film page:
 * - "v.o.a. : …", "v.o. : …", "titre original : …"
 * - JSON-LD alternateName/name (if present)
 */
export async function fetchLanguageDerivedTitles(baseFilmUrl) {
    const res = await fetch(baseFilmUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const out = new Set();

    // 1) Explicit language block(s)
    $('.movie-languages-content').each((_, el) => {
        const txt = $(el).text().replace(/\s+/g, ' ').trim();
        // capture “v.o.a. : Title”, “v.o. : Title”, “v.o.a. s.-t.f. : Title”
        const re = /(v\.?\s*o\.?\s*a?\.?(?:[^:]*?)|titre\s+original)[^:]*:\s*([^|•<\n]+)$/gi;
        let m;
        while ((m = re.exec(txt)) !== null) {
            const t = (m[2] || '').trim();
            if (t) out.add(t);
        }
    });

    // 2) Anywhere on the page: "Titre original : …"
    const body = $('body').text().replace(/\s+/g, ' ');
    const m2 = body.match(/Titre\s+original\s*:?\s*([^|•<\n]{2,120})/i);
    if (m2?.[1]) out.add(m2[1].trim());

    // 3) JSON-LD: alternateName (or name as a fallback)
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).contents().text());
            const nodes = Array.isArray(data) ? data : [data];
            for (const n of nodes) {
                if (n && (n['@type'] === 'Movie' || n['@type'] === 'CreativeWork')) {
                    const alt = (n.alternateName || n.name || '').trim();
                    if (alt) out.add(alt);
                }
            }
        } catch {}
    });

    return [...out];
}

