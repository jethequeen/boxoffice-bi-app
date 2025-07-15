import { getClient } from '../db/client.js';

function getWeekId(dateString) {
    const date = new Date(dateString);
    const year = date.getFullYear();

    const tempDate = new Date(date);
    tempDate.setHours(0, 0, 0, 0);
    tempDate.setDate(tempDate.getDate() + 3 - ((tempDate.getDay() + 6) % 7));
    const firstThursday = new Date(tempDate.getFullYear(), 0, 4);
    const weekNumber = 1 + Math.round(((tempDate - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);

    return parseInt(`${weekNumber}${year}`);
}

export async function insertRevenue(tmdbId, metadata, weekEndDate, data, theaterCount, usData = null) {
    const client = getClient();
    await client.connect();

    try {
        const weekendId = getWeekId(weekEndDate);

        // 📅 1. Insérer ou récupérer le weekend
        let res = await client.query(`SELECT id FROM weekends WHERE id = $1`, [weekendId]);
        if (res.rowCount === 0) {
            await client.query(
                `INSERT INTO weekends (id, start_date, end_date) VALUES ($1, $2, $2)`,
                [weekendId, weekEndDate]
            );
        }

        // 💰 2. Insérer ou mettre à jour les revenus
        const revenueUs = usData?.weekEnd ?? null;

        res = await client.query(
            `SELECT id FROM revenues WHERE film_id = $1 AND weekend_id = $2`,
            [tmdbId, weekendId]
        );

        if (res.rowCount === 0) {
            await client.query(
                `INSERT INTO revenues (film_id, weekend_id, revenue_qc, revenue_us, rank, theater_count)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [tmdbId, weekendId, data.weekEnd, revenueUs, data.position, theaterCount]
            );
        } else {
            await client.query(
                `UPDATE revenues
                 SET revenue_qc = $1,
                     revenue_us = $2,
                     rank = $3,
                     theater_count = $5
                 WHERE id = $4`,
                [data.weekEnd, revenueUs, data.position, res.rows[0].id, theaterCount]
            );
        }

        console.log(`✓ ${metadata.title} (TMDB ID: ${tmdbId}) revenu inséré`);
    } catch (err) {
        console.error("❌ Erreur dans insertRevenue:", err);
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
