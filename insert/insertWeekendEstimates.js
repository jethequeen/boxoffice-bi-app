// insert/insertWeekendEstimates.js
import { getClient } from '../db/client.js';
import { refreshPopularity } from '../helpers/refreshPopularity.js';

// add this helper (same logic you used server-side)
function fridaySundayFromWeekendId(weekendId) {
    const s = String(weekendId);
    const isoYear = Number(s.slice(0, 4));
    const isoWeek = Number(s.slice(4));
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Dow = (jan4.getUTCDay() + 6) % 7;              // 0=Mon..6=Sun
    const monday = new Date(Date.UTC(isoYear, 0, 4 - jan4Dow + (isoWeek - 1) * 7));
    const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
    const friday = new Date(sunday); friday.setUTCDate(sunday.getUTCDate() - 2);
    const toISO = (d) => d.toISOString().slice(0, 10);
    return { startISO: toISO(friday), endISO: toISO(sunday) };
}


export async function insertWeekendEstimates(weekendId, ticketPrice = 14, biasScale = 0.70) {
    const client = getClient();
    await client.connect();

    // --- ensure the weekend row exists (idempotent) ---
    try {
        const { startISO, endISO } = fridaySundayFromWeekendId(weekendId);
        await client.query(
            `
    INSERT INTO weekends (id, start_date, end_date)
    VALUES ($1, $2::date, $3::date)
    ON CONFLICT (id) DO UPDATE
      SET start_date = EXCLUDED.start_date,
          end_date   = EXCLUDED.end_date
    `,
            [weekendId, startISO, endISO]
        );
    } catch (e) {
        console.error(`[estimates] failed to ensure weekend ${weekendId}:`, e.message);
        // you can choose to throw here; if you continue, later queries will succeed
    }


    // --- diagnostics: print weekend date range & counts (Fri–Sun) ---
    try {
        const wRes = await client.query(
            `SELECT id, start_date, end_date FROM weekends WHERE id = $1`,
            [weekendId]
        );
        if (wRes.rowCount === 0) {
            console.warn(`[estimates] weekend ${weekendId} not found in weekends table.`);
            return;
        }
        const { start_date, end_date } = wRes.rows[0];
        console.log(`[estimates] Weekend ${weekendId}: ${start_date} .. ${end_date}`);

        const counts = await client.query(
            `
      WITH w AS (SELECT start_date, end_date FROM weekends WHERE id = $1)
      SELECT COUNT(*)::int AS total_cnt
      FROM showings s, w
      WHERE s.date BETWEEN w.start_date AND w.end_date
      `,
            [weekendId]
        );
        console.log(`[estimates] Fri–Sun total showings: ${counts.rows[0]?.total_cnt ?? 0}`);

        const existingEst = await client.query(
            `SELECT COUNT(*)::int AS n
         FROM revenues
        WHERE weekend_id = $1 AND data_source = 'estimate'`,
            [weekendId]
        );
        console.log(`[estimates] Existing 'estimate' rows before upsert: ${existingEst.rows[0]?.n ?? 0}`);
    } catch (dErr) {
        console.warn(`[estimates] preflight diagnostics failed:`, dErr.message);
    }

    try {
        await client.query('BEGIN');

        const sql = `
      WITH w AS (
        SELECT id, start_date, end_date
        FROM weekends
        WHERE id = $1
      ),

      /* ---------- candidates for fresh estimates ---------- */
      film_pool AS (
        SELECT DISTINCT s.movie_id::int AS film_id
        FROM showings s, w
        WHERE (s.date BETWEEN (w.end_date - INTERVAL '6 day') AND w.end_date)
           OR  (s.date = (w.start_date - INTERVAL '1 day'))
      ),
      already_had AS (
        SELECT r.film_id FROM revenues r WHERE r.weekend_id = $1
      ),
           cinoche_top10 AS (
               SELECT r.film_id
               FROM revenues r
               WHERE r.weekend_id = $1
                 AND r.data_source = 'cinoche'
                 AND r.rank BETWEEN 1 AND 10
           ),
      eligible AS (
        SELECT fp.film_id
        FROM film_pool fp
        WHERE fp.film_id NOT IN (SELECT film_id FROM cinoche_top10)  -- not a top-10 cinoche
          AND fp.film_id NOT IN (SELECT film_id FROM already_had)     -- not already present
      ),

      /* ---------- also include rows that already exist as 'estimate' so we can refresh them ---------- */
      existing_estimates AS (
        SELECT r.film_id
        FROM revenues r
        WHERE r.weekend_id = $1 AND r.data_source = 'estimate'
      ),
      targets AS (
        SELECT film_id FROM eligible
        UNION
        SELECT film_id FROM existing_estimates
      ),

           cinoche_floor AS (
               SELECT MIN(r.revenue_qc)::bigint AS floor_top10
               FROM revenues r
               WHERE r.weekend_id = $1
                 AND r.data_source = 'cinoche'
                 AND r.rank BETWEEN 1 AND 10
           ),


          /* ---------- is-first flags (for occupancy + seat estimation) ---------- */
           first_flags AS (
               SELECT t.film_id,
                      NOT EXISTS (
                          SELECT 1 FROM revenues r
                          WHERE r.film_id = t.film_id
                            AND r.weekend_id < $1  -- has this movie appeared in previous weekends?
                      ) AS is_first
               FROM targets t
           ),

           /* ---------- Check if first-week movies only have sales data from previews (no Fri-Sun sales data) ---------- */
           preview_only_flags AS (
               SELECT
                   ff.film_id,
                   -- Has seats_sold data from preview days
                   EXISTS (
                       SELECT 1 FROM showings s, w
                       WHERE s.movie_id = ff.film_id
                         AND s.date BETWEEN (w.start_date - INTERVAL '3 days') AND (w.start_date - INTERVAL '1 day')
                         AND s.seats_sold IS NOT NULL
                   )
                   AND
                   -- But NO seats_sold data from Fri-Sun
                   NOT EXISTS (
                       SELECT 1 FROM showings s, w
                       WHERE s.movie_id = ff.film_id
                         AND s.date BETWEEN w.start_date AND w.end_date
                         AND s.seats_sold IS NOT NULL
                   ) AS is_preview_only
               FROM first_flags ff
               WHERE ff.is_first = true
           ),

      /* ---------- Weekend base for estimates (includes previews for first week) ---------- */
      wk_base AS (
        SELECT
          s.movie_id::int AS film_id,
          s.screen_id,
          (s.start_at AT TIME ZONE 'America/Toronto')::time AS local_time,
          s.seats_sold::numeric AS seats_sold
        FROM showings s
        JOIN first_flags ff ON ff.film_id = s.movie_id::int
        JOIN w ON TRUE
        WHERE s.date BETWEEN
          CASE WHEN ff.is_first THEN (w.start_date - INTERVAL '3 days') ELSE w.start_date END
          AND w.end_date
      ),

           wk_present AS (
               SELECT DISTINCT film_id
               FROM wk_base        
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

      /* ---------- showings_proportion (Fri–Sun for ALL films) ---------- */
      counts_per_film AS (
        SELECT s.movie_id::int AS film_id, COUNT(*)::int AS film_cnt
        FROM showings s, w
        WHERE s.date BETWEEN w.start_date AND w.end_date
        GROUP BY s.movie_id
      ),
      counts_total AS (
        SELECT COUNT(*)::int AS total_cnt
        FROM showings s, w
        WHERE s.date BETWEEN w.start_date AND w.end_date
      ),

      /* ---------- weekend features ---------- */
      wk_occ AS (
        SELECT
          b.film_id,
          CASE
            WHEN SUM(CASE WHEN sc.seat_count IS NOT NULL THEN 1 ELSE 0 END) = 0
              THEN NULL
            ELSE
              (SUM(b.seats_sold) FILTER (WHERE sc.seat_count IS NOT NULL))::numeric
              / NULLIF(SUM(sc.seat_count) FILTER (WHERE sc.seat_count IS NOT NULL), 0)
          END AS average_showing_occupancy
        FROM wk_b b
        LEFT JOIN screens sc ON sc.id = b.screen_id
        WHERE b.seats_sold IS NOT NULL
        GROUP BY b.film_id
      ),
      wk_features AS (
        SELECT
          t.film_id,
          o.average_showing_occupancy,
          COALESCE(
            (COALESCE(cpf.film_cnt,0)::numeric / NULLIF(ct.total_cnt,0)),
            0::numeric
          ) AS showings_proportion
        FROM targets t
        LEFT JOIN wk_occ          o   USING (film_id)
        LEFT JOIN counts_per_film cpf USING (film_id)
        CROSS JOIN counts_total   ct
      ),

      /* ---------- estimation for missing seats (unchanged) ---------- */
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
          -- Scale up preview averages by 2x for preview-only movies
          COALESCE(k.avg_tf, a.avg_any) * CASE WHEN COALESCE(pof.is_preview_only, false) THEN 2.0 ELSE 1 END AS est_per_show
        FROM wk_b b
        LEFT JOIN wk_known k USING (film_id, tf)
        LEFT JOIN wk_any   a USING (film_id)
        LEFT JOIN preview_only_flags pof ON pof.film_id = b.film_id
        GROUP BY b.film_id, b.tf, COALESCE(k.avg_tf, a.avg_any), pof.is_preview_only
      ),
      wk_seats AS (
        SELECT
          film_id,
          SUM(
            CASE
              WHEN missing_cnt > 0 AND est_per_show IS NULL THEN NULL
              ELSE known_sum + missing_cnt * COALESCE(est_per_show, 0)
            END
          ) AS seats_weekend
        FROM wk_per_tf
        GROUP BY film_id
      ),

      /* ---------- Midweek (Mon..Thu) before weekend (for cumulative only) ---------- */
      mw_base AS (
        SELECT
          s.movie_id::int AS film_id,
          (s.start_at AT TIME ZONE 'America/Toronto')::time AS local_time,
          s.seats_sold::numeric AS seats_sold
        FROM showings s
        JOIN first_flags ff ON ff.film_id = s.movie_id::int
        JOIN w ON TRUE
        WHERE s.date BETWEEN (w.end_date - INTERVAL '6 day')
                       AND CASE WHEN ff.is_first THEN (w.start_date - INTERVAL '4 days') ELSE (w.start_date - INTERVAL '1 day') END
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
            CASE
              WHEN missing_cnt > 0 AND est_per_show IS NULL THEN NULL
              ELSE known_sum + missing_cnt * COALESCE(est_per_show, 0)
            END
          ) AS seats_midweek
        FROM mw_per_tf
        GROUP BY film_id
      ),

           weekend_money AS (
               SELECT
                   t.film_id,
                   CASE
                       WHEN wk.seats_weekend IS NULL THEN NULL
                       WHEN cf.floor_top10 IS NULL
                           THEN GREATEST(0, (wk.seats_weekend * $2 * $3))::bigint
                       ELSE
                           GREATEST(0, LEAST((wk.seats_weekend * $2 * $3), cf.floor_top10 - 10))::bigint
                       END AS revenue_weekend
               FROM targets t
                        LEFT JOIN wk_seats     wk USING (film_id)
                        LEFT JOIN cinoche_floor cf ON TRUE
           ),

           midweek_money AS (
               SELECT t.film_id,
                      CASE WHEN mw.seats_midweek IS NULL THEN NULL
                           ELSE (mw.seats_midweek * $2 * $3)::bigint END AS revenue_midweek
               FROM targets t
                        LEFT JOIN mw_seats mw USING (film_id)
           ),
      prev_weekend_rev AS (
        SELECT t.film_id,
               (SELECT r.revenue_qc
                FROM revenues r
                WHERE r.film_id = t.film_id AND r.weekend_id < $1
                ORDER BY r.weekend_id DESC
                LIMIT 1)::bigint AS prev_rev
        FROM targets t
      ),
      is_first_real_weekend AS (
        SELECT t.film_id,
               NOT EXISTS (
                 SELECT 1
                 FROM revenues r
                 JOIN weekends w2 ON w2.id = r.weekend_id
                 JOIN movies m ON m.id = t.film_id
                 WHERE r.film_id = t.film_id
                   AND r.weekend_id < $1
                   AND w2.end_date >= m.release_date
               ) AS is_first_real
        FROM targets t
      ),
      prev_cumul AS (
        SELECT t.film_id,
               COALESCE((SELECT r.cumulatif_qc_to_date
                         FROM revenues r
                         WHERE r.film_id = t.film_id AND r.weekend_id < $1
                         ORDER BY r.weekend_id DESC
                         LIMIT 1), 0)::bigint AS cumul_prev
        FROM targets t
      ),
      final_rows AS (
        SELECT
          t.film_id,
          wm.revenue_weekend AS rev_wk,
          mm.revenue_midweek AS rev_mw,
          pc.cumul_prev      AS cumul_prev,
          (pc.cumul_prev + COALESCE(mm.revenue_midweek,0) + COALESCE(wm.revenue_weekend,0))::bigint AS cumul_now,
          CASE
            WHEN ifrw.is_first_real THEN NULL
            WHEN wm.revenue_weekend IS NULL OR pwr.prev_rev IS NULL OR pwr.prev_rev = 0 THEN NULL
            ELSE LEAST(9999.99, GREATEST(-9999.99, ROUND(((wm.revenue_weekend::numeric / pwr.prev_rev::numeric) - 1) * 100, 2)))
          END::numeric(6,2) AS change_qc,
          wf.average_showing_occupancy::numeric(6,4) AS average_showing_occupancy,
          wf.showings_proportion::numeric(6,4)       AS showings_proportion
        FROM targets t
        JOIN wk_present      wp   USING (film_id)
        JOIN weekend_money    wm  USING (film_id)
        JOIN midweek_money    mm  USING (film_id)
        JOIN prev_cumul       pc  USING (film_id)
        JOIN prev_weekend_rev pwr USING (film_id)
        JOIN is_first_real_weekend ifrw USING (film_id)
        LEFT JOIN wk_features wf  USING (film_id)
      )

      INSERT INTO revenues (
        film_id, weekend_id, revenue_qc, data_source,
        cumulatif_qc_to_date, change_qc,
        average_showing_occupancy, showings_proportion
      )
      SELECT film_id, $1, rev_wk, 'estimate',
             cumul_now, change_qc,
             average_showing_occupancy, showings_proportion
      FROM final_rows
      ON CONFLICT (film_id, weekend_id) DO UPDATE
        SET
          -- only refresh if this row is an estimate
          revenue_qc                = CASE WHEN revenues.data_source = 'estimate'
                                           THEN EXCLUDED.revenue_qc ELSE revenues.revenue_qc END,
          cumulatif_qc_to_date      = CASE WHEN revenues.data_source = 'estimate'
                                           THEN EXCLUDED.cumulatif_qc_to_date ELSE revenues.cumulatif_qc_to_date END,
          change_qc                 = CASE WHEN revenues.data_source = 'estimate'
                                           THEN EXCLUDED.change_qc ELSE revenues.change_qc END,
          average_showing_occupancy = CASE WHEN revenues.data_source = 'estimate'
                                           THEN EXCLUDED.average_showing_occupancy ELSE revenues.average_showing_occupancy END,
          showings_proportion       = CASE WHEN revenues.data_source = 'estimate'
                                           THEN EXCLUDED.showings_proportion ELSE revenues.showings_proportion END
      WHERE revenues.data_source = 'estimate'
      RETURNING film_id;
    `;

        const upsert = await client.query(sql, [weekendId, ticketPrice, biasScale]);
        console.log(`[estimates] Upserted/updated rows: ${upsert.rowCount}`);

        // Re-rank with tie-breakers (unchanged)
        await client.query(
            `
                WITH totals AS (
                    SELECT
                        f.film_id,
                        r.weekend_id,
                        COALESCE(
                                (SELECT r2.revenue_qc::numeric
                                 FROM revenues r2
                                 WHERE r2.film_id = f.film_id
                                   AND r2.weekend_id = r.weekend_id
                                   AND r2.data_source = 'cinoche'
                                 LIMIT 1),
                                (SELECT r3.revenue_qc::numeric
                                 FROM revenues r3
                                 WHERE r3.film_id = f.film_id
                                   AND r3.weekend_id = r.weekend_id
                                   AND r3.data_source = 'estimate'
                                 LIMIT 1)
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
                                    SELECT 1 FROM revenues r
                                    WHERE r.film_id = t.film_id AND r.weekend_id < $1
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
                                                AND s.date BETWEEN
                                                    CASE WHEN ff.is_first THEN (w.start_date - INTERVAL '3 days') ELSE w.start_date END
                                                    AND w.end_date
                         GROUP BY t.film_id
                     ),
                     ranked AS (
                         SELECT
                             t.film_id,
                             $1::int AS weekend_id,
                             RANK() OVER (
                                 ORDER BY t.weekend_total DESC NULLS LAST,
                                     COALESCE(sc.show_count,0) DESC,
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

        await client.query('COMMIT');

        // --- diagnostics: how many estimate rows still have NULLs? ---
        try {
            const post = await client.query(
                `SELECT COUNT(*)::int AS n_null
           FROM revenues
          WHERE weekend_id = $1
            AND data_source = 'estimate'
            AND (showings_proportion IS NULL OR average_showing_occupancy IS NULL)`,
                [weekendId]
            );

            if ((post.rows[0]?.n_null ?? 0) > 0) {
                const sample = await client.query(
                    `SELECT film_id, showings_proportion, average_showing_occupancy
             FROM revenues
            WHERE weekend_id = $1 AND data_source = 'estimate'
            ORDER BY showings_proportion NULLS FIRST, average_showing_occupancy NULLS FIRST
            LIMIT 10`,
                    [weekendId]
                );
            }
        } catch (pErr) {
        }

        // Refresh popularity for rows actually inserted/updated
        for (const { film_id } of upsert.rows) {
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

// Run if executed directly
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
    const weekendId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
    const ticketPrice = process.argv[3] ? parseFloat(process.argv[3]) : 14;
    const biasScale = process.argv[4] ? parseFloat(process.argv[4]) : 0.9;

    if (!weekendId) {
        console.error('Usage: node insert/insertWeekendEstimates.js <weekendId> [ticketPrice] [biasScale]');
        console.error('Example: node insert/insertWeekendEstimates.js 202547 14 0.9');
        process.exit(1);
    }

    insertWeekendEstimates(weekendId, ticketPrice, biasScale)
        .then(() => {
            console.log('✅ Done');
            process.exit(0);
        })
        .catch(err => {
            console.error('❌ Error:', err);
            process.exit(1);
        });
}
