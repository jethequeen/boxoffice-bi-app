// insert/insertWeekendEstimates.js
import { getClient } from '../db/client.js';
import { refreshPopularity } from '../helpers/refreshPopularity.js'; // <-- add this import

export async function insertWeekendEstimates(weekendId, ticketPrice = 14) {
    const client = getClient();
    await client.connect();
    try {
        await client.query('BEGIN');

        const sql = `
            WITH w AS (
                SELECT id, start_date, end_date
                FROM weekends
                WHERE id = $1
            ),
                 film_pool AS (
                     SELECT DISTINCT s.movie_id::int AS film_id
                     FROM showings s, w
                     WHERE (s.date BETWEEN (w.end_date - INTERVAL '6 day') AND w.end_date)
                        OR (s.date = (w.start_date - INTERVAL '1 day'))
                 ),
                 cinoche_top10 AS (
                     SELECT r.film_id FROM revenues r WHERE r.weekend_id = $1 AND r.rank BETWEEN 1 AND 10
                 ),
                 already_had AS (
                     SELECT r.film_id FROM revenues r WHERE r.weekend_id = $1
                 ),
                 eligible AS (
                     SELECT fp.film_id
                     FROM film_pool fp
                     WHERE fp.film_id NOT IN (SELECT film_id FROM cinoche_top10)
                       AND fp.film_id NOT IN (SELECT film_id FROM already_had)
                 ),
                 first_flags AS (
                     SELECT e.film_id,
                            NOT EXISTS (
                                SELECT 1 FROM showings ss, w
                                WHERE ss.movie_id = e.film_id AND ss.date < w.start_date
                            ) AS is_first
                     FROM eligible e
                 ),

                /* ===== Weekend (Fri..Sun) + (Thu if first) ===== */
                 wk_base AS (
                     SELECT
                         s.movie_id::int AS film_id,
                         (s.start_at AT TIME ZONE 'America/Toronto')::time AS local_time,
                         s.seats_sold::numeric AS seats_sold
                     FROM showings s
                              JOIN first_flags ff ON ff.film_id = s.movie_id::int
                              JOIN w ON TRUE
                     WHERE (s.date BETWEEN w.start_date AND w.end_date)
                        OR (s.date = w.start_date - INTERVAL '1 day' AND ff.is_first)
                 ),
                 wk_banded AS (
                     SELECT *,
                            CASE
                                WHEN local_time BETWEEN TIME '11:00' AND TIME '13:59' THEN '11-14'
                                WHEN local_time BETWEEN TIME '14:00' AND TIME '17:59' THEN '14-18'
                                WHEN local_time BETWEEN TIME '18:00' AND TIME '20:29' THEN '18-2030'
                                WHEN local_time BETWEEN TIME '20:30' AND TIME '23:59' THEN '2030-24'
                                END AS tf
                     FROM wk_base
                 ),
                 wk_b AS (SELECT * FROM wk_banded WHERE tf IS NOT NULL),
                 wk_known AS (
                     SELECT film_id, tf, AVG(seats_sold) AS avg_tf
                     FROM wk_b
                     WHERE seats_sold IS NOT NULL
                     GROUP BY film_id, tf
                 ),
                 wk_any AS (
                     SELECT film_id, AVG(seats_sold) AS avg_any
                     FROM wk_b
                     WHERE seats_sold IS NOT NULL
                     GROUP BY film_id
                 ),
                 wk_per_tf AS (
                     SELECT
                         b.film_id,
                         b.tf,
                         COALESCE(SUM(seats_sold) FILTER (WHERE seats_sold IS NOT NULL), 0) AS known_sum,
                         COUNT(*) FILTER (WHERE seats_sold IS NULL)                         AS missing_cnt,
                         COALESCE(k.avg_tf, a.avg_any)                                      AS est_per_show
                     FROM wk_b b
                              LEFT JOIN wk_known k USING (film_id, tf)
                              LEFT JOIN wk_any   a USING (film_id)
                     GROUP BY b.film_id, b.tf, COALESCE(k.avg_tf, a.avg_any)
                 ),
                 wk_seats AS (
                     SELECT
                         film_id,
                         SUM(
                                 CASE WHEN missing_cnt > 0 AND est_per_show IS NULL
                                          THEN NULL
                                      ELSE known_sum + missing_cnt * COALESCE(est_per_show, 0)
                                     END
                         ) AS seats_weekend
                     FROM wk_per_tf
                     GROUP BY film_id
                 ),

                /* ===== Midweek (Mon..Thu) before this weekend (for cumulative only) ===== */
                 mw_base AS (
                     SELECT
                         s.movie_id::int AS film_id,
                         (s.start_at AT TIME ZONE 'America/Toronto')::time AS local_time,
                         s.seats_sold::numeric AS seats_sold
                     FROM showings s
                              JOIN first_flags ff ON ff.film_id = s.movie_id::int
                              JOIN w ON TRUE
                     WHERE s.date BETWEEN (w.end_date - INTERVAL '6 day')
                               AND (w.start_date - CASE WHEN ff.is_first THEN INTERVAL '2 day' ELSE INTERVAL '1 day' END)
                 ),
                 mw_banded AS (
                     SELECT *,
                            CASE
                                WHEN local_time BETWEEN TIME '11:00' AND TIME '13:59' THEN '11-14'
                                WHEN local_time BETWEEN TIME '14:00' AND TIME '17:59' THEN '14-18'
                                WHEN local_time BETWEEN TIME '18:00' AND TIME '20:29' THEN '18-2030'
                                WHEN local_time BETWEEN TIME '20:30' AND TIME '23:59' THEN '2030-24'
                                END AS tf
                     FROM mw_base
                 ),
                 mw_b AS (SELECT * FROM mw_banded WHERE tf IS NOT NULL),
                 mw_known AS (
                     SELECT film_id, tf, AVG(seats_sold) AS avg_tf
                     FROM mw_b
                     WHERE seats_sold IS NOT NULL
                     GROUP BY film_id, tf
                 ),
                 mw_any AS (
                     SELECT film_id, AVG(seats_sold) AS avg_any
                     FROM mw_b
                     WHERE seats_sold IS NOT NULL
                     GROUP BY film_id
                 ),
                 mw_per_tf AS (
                     SELECT
                         b.film_id,
                         b.tf,
                         COALESCE(SUM(seats_sold) FILTER (WHERE seats_sold IS NOT NULL), 0) AS known_sum,
                         COUNT(*) FILTER (WHERE seats_sold IS NULL)                         AS missing_cnt,
                         COALESCE(k.avg_tf, a.avg_any, wa.avg_any)                          AS est_per_show
                     FROM mw_b b
                              LEFT JOIN mw_known k USING (film_id, tf)
                              LEFT JOIN mw_any   a USING (film_id)
                              LEFT JOIN wk_any   wa USING (film_id)
                     GROUP BY b.film_id, b.tf, COALESCE(k.avg_tf, a.avg_any, wa.avg_any)
                 ),
                 mw_seats AS (
                     SELECT
                         film_id,
                         SUM(
                                 CASE WHEN missing_cnt > 0 AND est_per_show IS NULL
                                          THEN NULL
                                      ELSE known_sum + missing_cnt * COALESCE(est_per_show, 0)
                                     END
                         ) AS seats_midweek
                     FROM mw_per_tf
                     GROUP BY film_id
                 ),

                 films AS (SELECT film_id FROM eligible),

                 weekend_money AS (
                     SELECT
                         f.film_id,
                         CASE
                             WHEN wk.seats_weekend IS NULL THEN NULL
                             ELSE GREATEST(
                                     0,
                                     LEAST(
                                             wk.seats_weekend * $2,
                                             COALESCE((SELECT MIN(r2.revenue_qc)
                                                       FROM revenues r2
                                                       WHERE r2.weekend_id = $1 AND r2.rank BETWEEN 1 AND 10), 1e12) - 10
                                     )
                                  )::bigint
                             END AS revenue_weekend
                     FROM films f
                              LEFT JOIN wk_seats wk USING (film_id)
                 ),
                 midweek_money AS (
                     SELECT f.film_id,
                            CASE WHEN mw.seats_midweek IS NULL THEN NULL
                                 ELSE (mw.seats_midweek * $2)::bigint END AS revenue_midweek
                     FROM films f
                              LEFT JOIN mw_seats mw USING (film_id)
                 ),
                 prev_weekend_rev AS (
                     SELECT f.film_id,
                            (SELECT r.revenue_qc
                             FROM revenues r
                             WHERE r.film_id = f.film_id AND r.weekend_id < $1
                             ORDER BY r.weekend_id DESC
                             LIMIT 1)::bigint AS prev_rev
                     FROM films f
                 ),
                 prev_cumul AS (
                     SELECT f.film_id,
                            COALESCE((SELECT r.cumulatif_qc_to_date
                                      FROM revenues r
                                      WHERE r.film_id = f.film_id AND r.weekend_id < $1
                                      ORDER BY r.weekend_id DESC
                                      LIMIT 1), 0)::bigint AS cumul_prev
                     FROM films f
                 ),
                 final_rows AS (
                     SELECT
                         f.film_id,
                         wm.revenue_weekend AS rev_wk,
                         mm.revenue_midweek AS rev_mw,
                         pc.cumul_prev      AS cumul_prev,
                         (pc.cumul_prev + COALESCE(mm.revenue_midweek,0) + COALESCE(wm.revenue_weekend,0))::bigint AS cumul_now,
                         CASE
                             WHEN wm.revenue_weekend IS NULL OR pwr.prev_rev IS NULL OR pwr.prev_rev = 0 THEN NULL
                             ELSE ROUND(((wm.revenue_weekend::numeric / pwr.prev_rev::numeric) - 1) * 100, 2)
                             END::numeric(6,2) AS change_qc
                     FROM films f
                              JOIN weekend_money    wm  USING (film_id)
                              JOIN midweek_money    mm  USING (film_id)
                              JOIN prev_cumul       pc  USING (film_id)
                              JOIN prev_weekend_rev pwr USING (film_id)
                 )

            INSERT INTO revenues (film_id, weekend_id, revenue_qc, data_source, cumulatif_qc_to_date, change_qc)
            SELECT film_id, $1, rev_wk, 'estimate', cumul_now, change_qc
            FROM final_rows
            ON CONFLICT (film_id, weekend_id) DO NOTHING
            RETURNING film_id;   -- <-- no semicolon before RETURNING
        `;

        // capture rows so we can refresh popularity
        const { rows } = await client.query(sql, [weekendId, ticketPrice]);

        // Re-rank with your tie-breakers
        await client.query(`
      WITH w AS (
        SELECT start_date, end_date FROM weekends WHERE id = $1
      ),
      films AS (
        SELECT DISTINCT r.film_id FROM revenues r WHERE r.weekend_id = $1
      ),
      first_flags AS (
        SELECT f.film_id,
               NOT EXISTS (SELECT 1 FROM showings ss, w
                           WHERE ss.movie_id = f.film_id AND ss.date < w.start_date) AS is_first
        FROM films f
      ),
      show_counts AS (
        SELECT f.film_id, COUNT(s.*)::int AS show_count
        FROM films f
        JOIN w ON TRUE
        LEFT JOIN first_flags ff ON ff.film_id = f.film_id
        LEFT JOIN showings s
          ON s.movie_id = f.film_id
         AND ( s.date BETWEEN w.start_date AND w.end_date
               OR (s.date = w.start_date - INTERVAL '1 day' AND ff.is_first) )
        GROUP BY f.film_id
      ),
      ranked AS (
        SELECT r.film_id, r.weekend_id,
               RANK() OVER (
                 PARTITION BY r.weekend_id
                 ORDER BY r.revenue_qc DESC NULLS LAST,
                          COALESCE(sc.show_count,0) DESC,
                          r.cumulatif_qc_to_date DESC NULLS LAST,
                          r.film_id
               ) AS r
        FROM revenues r
        LEFT JOIN show_counts sc ON sc.film_id = r.film_id
        WHERE r.weekend_id = $1
      )
      UPDATE revenues r
      SET rank = rk.r
      FROM ranked rk
      WHERE r.film_id = rk.film_id
        AND r.weekend_id = rk.weekend_id
        AND r.weekend_id = $1;
    `, [weekendId]);

        await client.query('COMMIT');

        // Refresh popularity for the rows actually inserted
        for (const { film_id } of rows) {
            try { await refreshPopularity(film_id); }
            catch (e) { console.error(`⚠️ Popularity refresh failed for film ${film_id}:`, e.message); }
        }

    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ insertWeekendEstimates failed:', e);
        throw e;
    } finally {
        await client.end();
    }
}
