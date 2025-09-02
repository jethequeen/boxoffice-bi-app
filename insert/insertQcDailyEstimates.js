// insert/insertDailyEstimates.js
import { getClient } from '../db/client.js';

export async function insertQcDailyEstimates(dayISO, ticketPrice = 14) {
    const client = getClient();
    await client.connect();

    try {
        await client.query('BEGIN');

        const sql = `
            WITH d AS (
                SELECT $1::date AS day
            ),
                /* all films that have at least one showing that day */
                 films AS (
                     SELECT DISTINCT s.movie_id::int AS film_id
                     FROM showings s, d
                     WHERE s.date = d.day
                 ),

                /* ---- features for the day (not weekend) ---- */
                 counts_per_film AS (
                     SELECT s.movie_id::int AS film_id, COUNT(*)::int AS film_cnt
                     FROM showings s, d
                     WHERE s.date = d.day
                     GROUP BY s.movie_id
                 ),
                 counts_total AS (
                     SELECT COUNT(*)::int AS total_cnt
                     FROM showings s, d
                     WHERE s.date = d.day
                 ),
                 day_base AS (
                     SELECT
                         s.movie_id::int AS film_id,
                         s.screen_id,
                         (s.start_at AT TIME ZONE 'America/Toronto')::time AS local_time,
                         s.seats_sold::numeric AS seats_sold
                     FROM showings s, d
                     WHERE s.date = d.day
                 ),
                 day_occ AS (
                     SELECT
                         b.film_id,
                         CASE
                             WHEN SUM(CASE WHEN sc.seat_count IS NOT NULL THEN 1 ELSE 0 END) = 0
                                 THEN NULL
                             ELSE
                                 (SUM(b.seats_sold) FILTER (WHERE sc.seat_count IS NOT NULL))::numeric
                                     / NULLIF(SUM(sc.seat_count) FILTER (WHERE sc.seat_count IS NOT NULL), 0)
                             END AS average_showing_occupancy
                     FROM day_base b
                              LEFT JOIN screens sc ON sc.id = b.screen_id
                     WHERE b.seats_sold IS NOT NULL
                     GROUP BY b.film_id
                 ),
                 day_features AS (
                     SELECT
                         f.film_id,
                         o.average_showing_occupancy::numeric(6,2) AS average_showing_occupancy,
                         (COALESCE(cpf.film_cnt,0)::numeric / NULLIF(ct.total_cnt,0))::numeric(6,4) AS showings_proportion
                     FROM films f
                              LEFT JOIN day_occ         o   USING (film_id)
                              LEFT JOIN counts_per_film cpf USING (film_id)
                              CROSS JOIN counts_total   ct
                 ),

                /* ---- per-timeframe estimation for the day ---- */
                 day_banded AS (
                     SELECT *,
                            CASE
                                WHEN local_time BETWEEN TIME '11:00' AND TIME '13:59' THEN '11-14'
                                WHEN local_time BETWEEN TIME '14:00' AND TIME '17:59' THEN '14-18'
                                WHEN local_time BETWEEN TIME '18:00' AND TIME '20:29' THEN '18-2030'
                                WHEN local_time BETWEEN TIME '20:30' AND TIME '23:59' THEN '2030-24'
                                END AS tf
                     FROM day_base
                 ),
                 db AS (SELECT * FROM day_banded WHERE tf IS NOT NULL),

                 known AS (
                     SELECT film_id, tf, AVG(seats_sold) AS avg_tf
                     FROM db
                     WHERE seats_sold IS NOT NULL
                     GROUP BY film_id, tf
                 ),
                 any_avg AS (
                     SELECT film_id, AVG(seats_sold) AS avg_any
                     FROM db
                     WHERE seats_sold IS NOT NULL
                     GROUP BY film_id
                 ),
                 per_tf AS (
                     SELECT
                         b.film_id,
                         b.tf,
                         COALESCE(SUM(seats_sold) FILTER (WHERE seats_sold IS NOT NULL), 0) AS known_sum,
                         COUNT(*) FILTER (WHERE seats_sold IS NULL)                         AS missing_cnt,
                         COALESCE(k.avg_tf, a.avg_any)                                      AS est_per_show
                     FROM db b
                              LEFT JOIN known   k USING (film_id, tf)
                              LEFT JOIN any_avg a USING (film_id)
                     GROUP BY b.film_id, b.tf, COALESCE(k.avg_tf, a.avg_any)
                 ),
                 seats_for_day AS (
                     SELECT
                         film_id,
                         SUM(
                                 CASE
                                     WHEN missing_cnt > 0 AND est_per_show IS NULL THEN NULL
                                     ELSE known_sum + missing_cnt * COALESCE(est_per_show, 0)
                                     END
                         ) AS seats_day
                     FROM per_tf
                     GROUP BY film_id
                 ),

                 final_rows AS (
                     SELECT
                         f.film_id,
                         (SELECT day FROM d) AS date,
                         CASE WHEN sfd.seats_day IS NULL THEN NULL
                              ELSE (sfd.seats_day * $2)::bigint END AS revenue_qc
                     FROM films f
                              LEFT JOIN seats_for_day sfd USING (film_id)
                 ),

                /* ---- compute daily ranks (same-day partition) ---- */
                 ranked AS (
                     SELECT
                         fr.film_id,
                         fr.date,
                         fr.revenue_qc,
                         RANK() OVER (
                             PARTITION BY fr.date
                             ORDER BY fr.revenue_qc DESC NULLS LAST,
                                 COALESCE(cpf.film_cnt,0) DESC,
                                 fr.film_id
                             ) AS r
                     FROM final_rows fr
                              LEFT JOIN counts_per_film cpf USING (film_id)
                 )

            INSERT INTO daily_revenues (
                film_id, "date",
                revenue_qc,
                rank,
                revenue_us,
                force_qc_usa,
                change_qc,
                change_us,
                week_count,
                average_showing_occupancy,
                showings_proportion
            )
            SELECT
                rk.film_id, rk.date,
                rk.revenue_qc,
                rk.r,
                NULL::bigint,
                NULL::numeric,
                NULL::numeric,
                NULL::numeric,
                NULL::int,
                df.average_showing_occupancy,
                df.showings_proportion
            FROM ranked rk
                     LEFT JOIN day_features df USING (film_id)
            ON CONFLICT (film_id, "date") DO UPDATE
                SET revenue_qc                = EXCLUDED.revenue_qc,
                    rank                      = EXCLUDED.rank,
                    average_showing_occupancy = EXCLUDED.average_showing_occupancy,
                    showings_proportion       = EXCLUDED.showings_proportion;
        `;

        const res = await client.query(sql, [dayISO, ticketPrice]);
        await client.query('COMMIT');
        console.log(`[daily-estimates] upserted for ${dayISO}: ${res.rowCount} row(s)`);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ insertDailyEstimates failed:', e);
        throw e;
    } finally {
        await client.end();
    }
}
