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


export function addDaysISO(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
}


export function getWeekendId_YYYYWW(dateString) {
    const iso = toISODate(dateString);
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 3 - ((tmp.getUTCDay() + 6) % 7));
    const isoYear = tmp.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    const week = 1 + Math.round(((tmp - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    const WW = String(week).padStart(2, '0');
    return Number(`${isoYear}${WW}`);
}


export async function recomputeRanksForWeekend(client, weekendId) {
    await client.query(
        `
            WITH totals AS (
                SELECT
                    f.film_id,
                    r.weekend_id,
                    COALESCE(
                        -- Prefer Cinoche's canonical weekend total if present
                            (SELECT r2.revenue_qc
                             FROM revenues r2
                             WHERE r2.film_id = f.film_id
                               AND r2.weekend_id = r.weekend_id
                               AND r2.data_source = 'cinoche'
                             LIMIT 1),
                        -- Otherwise, sum our daily estimate rows for Fri..Sun only
                            (SELECT SUM(r3.revenue_qc)
                             FROM revenues r3
                             WHERE r3.film_id = f.film_id
                               AND r3.weekend_id = r.weekend_id
                               AND r3.data_source = 'estimate'
                               AND r3.preview = false
                               AND r3.date IS NOT NULL)
                    ) AS weekend_total
                FROM (SELECT DISTINCT film_id FROM revenues WHERE weekend_id = $1) f
                         CROSS JOIN LATERAL (SELECT $1::int AS weekend_id) r
            ),
                 w AS (
                     SELECT start_date, end_date FROM weekends WHERE id = $1
                 ),
                 first_flags AS (
                     SELECT t.film_id,
                            NOT EXISTS (
                                SELECT 1 FROM showings ss, w
                                WHERE ss.movie_id = t.film_id AND ss.date < w.start_date
                            ) AS is_first
                     FROM (SELECT DISTINCT film_id FROM revenues WHERE weekend_id = $1) t
                 ),
                 show_counts AS (
                     SELECT t.film_id, COUNT(s.*)::int AS show_count
                     FROM (SELECT DISTINCT film_id FROM revenues WHERE weekend_id = $1) t
                              JOIN w ON TRUE
                              LEFT JOIN first_flags ff ON ff.film_id = t.film_id
                              LEFT JOIN showings s
                                        ON s.movie_id = t.film_id
                                            AND ( s.date BETWEEN w.start_date AND w.end_date
                                                OR (s.date = w.start_date - INTERVAL '1 day' AND ff.is_first) )
                     GROUP BY t.film_id
                 ),
                 ranked AS (
                     SELECT
                         t.film_id,
                         $1::int AS weekend_id,
                         RANK() OVER (
                             ORDER BY t.weekend_total DESC NULLS LAST,
                                 COALESCE(sc.show_count,0) DESC,
                                 -- optional tie-breaker that remains stable:
                                 t.film_id
                             ) AS r
                     FROM totals t
                              LEFT JOIN show_counts sc ON sc.film_id = t.film_id
                 )
            UPDATE revenues r
            SET rank = rk.r
            FROM ranked rk
            WHERE r.weekend_id = rk.weekend_id
              AND r.film_id = rk.film_id
              AND r.weekend_id = $1;

    `,
        [weekendId]
    );
}


export async function insertRevenue(
    tmdbId,
    metadata,
    weekEndDate,
    data,
    usData = null
) {
    const client = getClient();
    await client.connect();
    try {
        const fridayISO = toISODate(weekEndDate);
        const startISO  = fridayISO;
        const endISO    = addDaysISO(fridayISO, 2);   // Sunday
        const weekendId = getWeekendId_YYYYWW(endISO);

        // Parse numbers from Cinoche payloads
        const revenueQc = data?.weekEnd != null ? Number(data.weekEnd) : 0;
        const revenueUs = usData?.weekEnd != null ? Number(usData.weekEnd) : null;
        const rank      = data?.position != null ? Number(data.position) : null;
        const cumulQc   = data?.cumulative != null ? Number(data.cumulative) : null;
        const cumulUs   = usData?.cumulative != null ? Number(usData.cumulative) : null;

        await client.query('BEGIN');

        // Ensure weekend exists
        await client.query(
            `INSERT INTO weekends (id, start_date, end_date)
       VALUES ($1, $2::date, $3::date)
       ON CONFLICT (id) DO UPDATE
         SET start_date = EXCLUDED.start_date,
             end_date   = EXCLUDED.end_date`,
            [weekendId, startISO, endISO]
        );

        // Insert/Upsert revenue + compute occupancy & showings proportion
        await client.query(
            `
      WITH w AS (
        SELECT start_date, end_date FROM weekends WHERE id = $2
      ),
      wk AS (
        SELECT s.movie_id::int AS film_id,
               s.screen_id,
               s.seats_sold::numeric AS seats_sold
        FROM showings s, w
        WHERE s.date BETWEEN w.start_date AND w.end_date
          AND s.movie_id::int = $1
      ),
      occ AS (
        SELECT
          CASE
            WHEN COUNT(*) FILTER (WHERE seats_sold IS NOT NULL) = 0 THEN NULL
            ELSE (SUM(seats_sold) / NULLIF(SUM(sc.seat_count),0))::numeric
          END AS average_occupancy
        FROM wk
        JOIN screens sc ON sc.id = wk.screen_id
        WHERE wk.seats_sold IS NOT NULL
      ),
      counts AS (
        SELECT
          (SELECT COUNT(*) FROM wk) AS film_cnt,
          (SELECT COUNT(*) FROM showings s, w
            WHERE s.date BETWEEN w.start_date AND w.end_date) AS total_cnt
      ),
      feats AS (
        SELECT
          o.average_occupancy::numeric(6,4) AS average_occupancy,
          (counts.film_cnt::numeric / NULLIF(counts.total_cnt,0))::numeric(6,4) AS showings_proportion
        FROM occ o, counts
      )
      INSERT INTO revenues (
        film_id, weekend_id, revenue_qc, revenue_us, rank,
        cumulatif_qc_to_date, cumulatif_us_to_date, data_source,
        average_showing_occupancy, showings_proportion
      )
      SELECT
        $1, $2, $3, $4, $5,
        $6, $7, 'cinoche',
        f.average_occupancy, f.showings_proportion
      FROM feats f
      ON CONFLICT (film_id, weekend_id) DO UPDATE SET
        revenue_qc              = EXCLUDED.revenue_qc,
        revenue_us              = EXCLUDED.revenue_us,
        rank                    = EXCLUDED.rank,
        cumulatif_qc_to_date    = COALESCE(EXCLUDED.cumulatif_qc_to_date, revenues.cumulatif_qc_to_date),
        cumulatif_us_to_date    = COALESCE(EXCLUDED.cumulatif_us_to_date, revenues.cumulatif_us_to_date),
        data_source             = 'cinoche',
        average_showing_occupancy = EXCLUDED.average_showing_occupancy,
        showings_proportion       = EXCLUDED.showings_proportion
      `,
            [tmdbId, weekendId, revenueQc, revenueUs, rank, cumulQc, cumulUs]
        );

        await recomputeRanksForWeekend(client, weekendId);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ Erreur dans insertRevenue:', err);
    } finally {
        await client.end();
    }
}
