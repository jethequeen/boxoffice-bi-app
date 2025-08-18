import { getClient } from '../db/client.js';

// --- helpers ---
function toISODate(input) {
    if (input instanceof Date && !isNaN(input.getTime())) return input.toISOString().slice(0, 10);
    const s = String(input).trim().replace(/[^\d/-]/g, '').replace(/\//g, '-')
        .replace(/-(\d{2})\d(?!\d)/, '-$1');
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) throw new Error(`Invalid date: ${input}`);
    const [_, y, mo, d] = m.map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (isNaN(dt.getTime())) throw new Error(`Invalid date values: ${s}`);
    return dt.toISOString().slice(0, 10);
}

function addDaysISO(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
}

// ISO year+week as YYYYWW
function getWeekendId_YYYYWW(dateString) {
    const iso = toISODate(dateString);
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 3 - ((tmp.getUTCDay() + 6) % 7));
    const isoYear = tmp.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    const week = 1 + Math.round(((tmp - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    const WW = String(week).padStart(2, '0');
    return Number(`${isoYear}${WW}`); // e.g. 202513
}




export async function insertRevenue(tmdbId, metadata, weekEndDate, data, theaterCount, usData = null) {
    const client = getClient();
    await client.connect();
    try {
        const endISO = toISODate(weekEndDate);
        const startISO = addDaysISO(endISO, -2);
        const weekendId = getWeekendId_YYYYWW(endISO);

        await client.query('BEGIN');

        await client.query(
            'INSERT INTO weekends (id, start_date, end_date) VALUES ($1, $2::date, $3::date) ' +
            'ON CONFLICT (id) DO UPDATE SET start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date',
            [weekendId, startISO, endISO]
        );

        const revenueUs = usData?.weekEnd == null ? null : Number(usData.weekEnd);
        const revenueQc = Number(data?.weekEnd) || 0;
        const rank = Number(data?.position) || null;
        const theaters = theaterCount == null ? null : Number(theaterCount);

        await client.query(
            'INSERT INTO revenues (film_id, weekend_id, revenue_qc, revenue_us, rank, theater_count) ' +
            'VALUES ($1, $2, $3, $4, $5, $6) ' +
            'ON CONFLICT (film_id, weekend_id) DO UPDATE SET ' +
            'revenue_qc = EXCLUDED.revenue_qc, revenue_us = EXCLUDED.revenue_us, rank = EXCLUDED.rank, theater_count = EXCLUDED.theater_count',
            [tmdbId, weekendId, revenueQc, revenueUs, rank, theaters]
        );

        await client.query('COMMIT');

        console.log(`✓ ${metadata.title} (TMDB ID: ${tmdbId}) revenu inséré`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ Erreur dans insertRevenue:', err);
    } finally {
        await client.end();
    }
}



export async function updateCumulatives(tmdbId, { qc, us }) {
    const client = getClient();
    await client.connect();

    try {
        await client.query(`
            UPDATE movies
            SET cumulatif_qc = $1,
                cumulatif_us = $2
            WHERE id = $3
        `, [qc, us, tmdbId]);

        console.log(`↪️ Cumulatif mis à jour pour ${tmdbId}: QC=${qc}, US=${us}`);
    } catch (e) {
        console.error("❌ Erreur dans updateCumulatives:", e);
    } finally {
        await client.end();
    }
}
