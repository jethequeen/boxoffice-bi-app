/*
// SQL Query used for computing, need adjustement

WITH params AS (
    SELECT
202534::int    AS weekend_id,
    0.85::numeric  AS decay,
    0.50::numeric  AS beta,
    0.01::numeric  AS epsilon,
    0.10::numeric  AS clamp_lo,
    1.00::numeric  AS clamp_hi,
    NULL::bigint   AS theater_id,
    '%maison%'::text AS theater_pattern
),
w AS (
    SELECT id, start_date, end_date
FROM weekends
WHERE id = (SELECT weekend_id FROM params)
),
top10 AS (
    SELECT film_id, rank, revenue_qc
FROM revenues
WHERE weekend_id = (SELECT weekend_id FROM params)
AND rank BETWEEN 1 AND 10
),
qc_showings_this AS (
    SELECT s.movie_id::int AS film_id, COUNT(*)::int AS total_showings_qc
FROM showings s
CROSS JOIN w
WHERE s.date BETWEEN w.start_date AND w.end_date
GROUP BY s.movie_id
),
per_show_top10 AS (
    SELECT
t.film_id,
    (t.revenue_qc::numeric / NULLIF(q.total_showings_qc,0)) AS dollars_per_showing
FROM top10 t
LEFT JOIN qc_showings_this q USING (film_id)
),
t10_sorted AS (
    SELECT p.film_id, p.dollars_per_showing,
    ROW_NUMBER() OVER (ORDER BY p.dollars_per_showing ASC) AS rn
FROM per_show_top10 p
),
t10_bottom3 AS (
    SELECT AVG(dollars_per_showing) AS bottom3_avg
FROM t10_sorted
WHERE rn >= 8
),
t10_min_revenue AS (
    SELECT MIN(revenue_qc)::numeric AS min_rev_qc
FROM top10
),
t10_pop AS (
    SELECT m.popularity AS pop, ROW_NUMBER() OVER (ORDER BY m.popularity) rn
FROM top10 t
JOIN movies m ON m.id = t.film_id
),
t10_pop_median AS (
    SELECT AVG(pop)::numeric AS pop_med
FROM t10_pop
WHERE rn IN (5,6)
),
bel AS (
    SELECT id AS theater_id
FROM theaters
WHERE (SELECT theater_id FROM params) IS NOT NULL
AND id = (SELECT theater_id FROM params)
OR ((SELECT theater_id FROM params) IS NULL
AND name ILIKE (SELECT theater_pattern FROM params))
ORDER BY id
LIMIT 1
),
bel_show AS (
    SELECT s.movie_id::int AS film_id, COUNT(*)::int AS showings
FROM showings s
JOIN bel b ON b.theater_id = s.theater_id
CROSS JOIN w
WHERE s.date BETWEEN w.start_date AND w.end_date
GROUP BY s.movie_id
),
qc_showings_all AS (
    SELECT ww.id AS weekend_id, s.movie_id::int AS film_id, COUNT(*)::int AS total_showings_qc
FROM showings s
JOIN weekends ww ON s.date BETWEEN ww.start_date AND ww.end_date
GROUP BY ww.id, s.movie_id
),
hist_candidates AS (
    SELECT
r.film_id,
    r.weekend_id,
    w2.start_date,
    r.revenue_qc,
    q.total_showings_qc,
    (r.revenue_qc::numeric / NULLIF(q.total_showings_qc,0)) AS dollars_per_showing_hist,
    ROW_NUMBER() OVER (PARTITION BY r.film_id ORDER BY w2.start_date DESC) AS rnk
FROM revenues r
JOIN weekends w2 ON w2.id = r.weekend_id
JOIN qc_showings_all q ON q.weekend_id = r.weekend_id AND q.film_id = r.film_id
WHERE r.rank BETWEEN 1 AND 10
AND r.weekend_id <> (SELECT weekend_id FROM params)
),
hist_latest AS (
    SELECT film_id, weekend_id, start_date, dollars_per_showing_hist
FROM hist_candidates
WHERE rnk = 1
),
hist_est AS (
    SELECT
h.film_id,
h.dollars_per_showing_hist
* POWER(
    (SELECT decay FROM params),
GREATEST(
    1,
    FLOOR(EXTRACT(EPOCH FROM age((SELECT w.start_date FROM w), h.start_date)) / 604800)
)
) AS dollars_per_showing_est_hist
FROM hist_latest h
),
pop_fallback AS (
    SELECT
m.id AS film_id,
    (SELECT bottom3_avg FROM t10_bottom3)
* GREATEST((SELECT clamp_lo FROM params),
LEAST((SELECT clamp_hi FROM params),
POWER(NULLIF(m.popularity,0) / NULLIF((SELECT pop_med FROM t10_pop_median),1),
(SELECT beta FROM params))
)
) AS dollars_per_showing_est_pop
FROM movies m
),
per_show_est_raw AS (
    SELECT
bm.film_id,
    COALESCE(pst.dollars_per_showing, he.dollars_per_showing_est_hist, pf.dollars_per_showing_est_pop, 120::numeric) AS dollars_per_showing_est,
    CASE
WHEN pst.dollars_per_showing IS NOT NULL THEN 'top10'
WHEN he.dollars_per_showing_est_hist IS NOT NULL THEN 'history'
WHEN pf.dollars_per_showing_est_pop IS NOT NULL THEN 'popularity_floor'
ELSE 'default_floor'
END AS source
FROM (SELECT DISTINCT film_id FROM bel_show) bm
LEFT JOIN per_show_top10 pst ON pst.film_id = bm.film_id
LEFT JOIN hist_est he        ON he.film_id  = bm.film_id
LEFT JOIN pop_fallback pf    ON pf.film_id  = bm.film_id
),
per_show_est AS (
    SELECT
r.film_id,
    CASE
WHEN r.source = 'top10' THEN r.dollars_per_showing_est
ELSE CASE
WHEN q.total_showings_qc IS NOT NULL
AND (r.dollars_per_showing_est * q.total_showings_qc)
>= ((SELECT min_rev_qc FROM t10_min_revenue) - (SELECT epsilon FROM params))
THEN (((SELECT min_rev_qc FROM t10_min_revenue) - (SELECT epsilon FROM params))
/ NULLIF(q.total_showings_qc,0))
ELSE r.dollars_per_showing_est
END
END AS dollars_per_showing_est,
    r.source
FROM per_show_est_raw r
LEFT JOIN qc_showings_this q ON q.film_id = r.film_id
),
per_film AS (
    SELECT
COALESCE(m.fr_title, m.title) AS title,
    e.source,
    ROUND(e.dollars_per_showing_est::numeric, 2) AS dollars_per_showing,
    b.showings,
    ROUND((e.dollars_per_showing_est * b.showings)::numeric, 2) AS revenue_est
FROM per_show_est e
JOIN bel_show b ON b.film_id = e.film_id
JOIN movies m   ON m.id = e.film_id
),
tot AS (
    SELECT SUM(revenue_est) AS total_revenue
FROM per_film
)
SELECT
p.title,
    p.source,
    ROUND(p.dollars_per_showing::numeric, 2) AS dollars_per_showing,
    p.showings,
    ROUND(p.revenue_est::numeric, 2) AS revenue_est,
    ROUND((p.revenue_est / NULLIF(t.total_revenue,0))::numeric * 100, 2) AS percent_of_total
FROM per_film p
CROSS JOIN tot t
UNION ALL
SELECT
'TOTAL',
    NULL,
    NULL,
    SUM(showings),
    ROUND(SUM(revenue_est)::numeric, 2),
    100.00
FROM per_film
ORDER BY percent_of_total DESC NULLS LAST;"
*/
