import { getClient } from '../db/client.js';

function getWeekId(dateString) {
    const date = new Date(dateString);
    const year = date.getFullYear();

    // ISO week number (based on https://en.wikipedia.org/wiki/ISO_week_date#Algorithms)
    const tempDate = new Date(date);
    tempDate.setHours(0, 0, 0, 0);
    tempDate.setDate(tempDate.getDate() + 3 - ((tempDate.getDay() + 6) % 7));
    const firstThursday = new Date(tempDate.getFullYear(), 0, 4);
    const weekNumber = 1 + Math.round(((tempDate - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);

    return parseInt(`${weekNumber}${year}`);
}

export async function insertRevenue(tmdbId, metadata, weekEndDate, data) {
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
        res = await client.query(
            `SELECT id FROM revenues WHERE film_id = $1 AND weekend_id = $2`,
            [tmdbId, weekendId]
        );

        if (res.rowCount === 0) {
            await client.query(
                `INSERT INTO revenues (film_id, weekend_id, revenue_qc, rank)
                 VALUES ($1, $2, $3, $4)`,
                [tmdbId, weekendId, data.weekEnd, data.position]
            );
        } else {
            await client.query(
                `UPDATE revenues
                 SET revenue_qc = $1, rank = $2
                 WHERE id = $3`,
                [data.weekEnd, data.position, res.rows[0].id]
            );
        }

        console.log(`✓ ${metadata.title} (TMDB ID: ${tmdbId}) revenu inséré`);
    } catch (err) {
        console.error("❌ Erreur dans insertRevenue:", err);
    } finally {
        await client.end();
    }
}
