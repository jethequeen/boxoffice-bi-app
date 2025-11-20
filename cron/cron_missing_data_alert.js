// cron/cron_missing_data_alert.js
import nodemailer from 'nodemailer';
import {getClient} from "../db/client.js";

/* ---------- Email config (from env or defaults) ---------- */
const EMAIL_HOST = process.env.EMAIL_HOST || 'localhost';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587', 10);
const EMAIL_SECURE = process.env.EMAIL_SECURE === 'true';
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@boxoffice.local';
const EMAIL_TO = process.env.EMAIL_TO || 'admin@boxoffice.local';

/* ---------- Alert window (5 hours after show start) ---------- */
const ALERT_HOURS_AFTER = 5;

async function checkMissingData() {
    const client = getClient();
    await client.connect();

    try {
        // Find shows that started 5+ hours ago and still have no seats_sold data
        const query = await client.query(`
            SELECT
                s.id                          AS showing_id,
                s.start_at,
                COALESCE(m.fr_title, m.title) AS movie_title,
                t.name                        AS theater_name,
                t.id                          AS theater_id
            FROM showings s
                JOIN theaters t ON t.id = s.theater_id
                JOIN movies m ON m.id = s.movie_id
            WHERE s.seats_sold IS NULL
              AND s.start_at < (now() - make_interval(hours => $1))
              AND s.start_at > (now() - make_interval(hours => $2))
              AND t.name LIKE '%Cineplex%'  -- Only check Cineplex theaters
            ORDER BY s.start_at DESC, t.name, m.fr_title
        `, [ALERT_HOURS_AFTER, ALERT_HOURS_AFTER + 24]); // Check shows from 5-29 hours ago

        if (query.rowCount === 0) {
            console.log('[missing-data-alert] ✓ No missing data found');
            return;
        }

        console.log(`[missing-data-alert] ⚠️ Found ${query.rowCount} shows with missing data`);

        // Group by theater for better readability
        const byTheater = {};
        for (const row of query.rows) {
            if (!byTheater[row.theater_name]) {
                byTheater[row.theater_name] = [];
            }
            byTheater[row.theater_name].push(row);
        }

        // Build email body
        let emailBody = `Found ${query.rowCount} Cineplex show(s) with missing seats_sold data:\n\n`;

        for (const [theater, shows] of Object.entries(byTheater)) {
            emailBody += `${theater} (${shows.length} shows):\n`;
            for (const show of shows) {
                const startTime = new Date(show.start_at).toLocaleString('en-CA', {
                    timeZone: 'America/Toronto',
                    dateStyle: 'short',
                    timeStyle: 'short'
                });
                emailBody += `  - ${show.movie_title} @ ${startTime} (showing_id: ${show.showing_id})\n`;
            }
            emailBody += '\n';
        }

        emailBody += `\nThis alert checks for shows that started ${ALERT_HOURS_AFTER}+ hours ago but still have no seats_sold data.\n`;

        // Send email (or log if no email config)
        await sendAlert(
            `⚠️ ${query.rowCount} Cineplex show(s) missing seats_sold data`,
            emailBody
        );

        // Exit with error code so GitHub Actions marks this as failed
        console.error('[missing-data-alert] Exiting with error code 1 to trigger GitHub notification');
        process.exit(1);

    } catch (e) {
        console.error('[missing-data-alert] error:', e?.message || e);
        throw e;
    } finally {
        await client.end();
    }
}

async function sendAlert(subject, body) {
    // If no email config, just log
    if (!EMAIL_HOST || EMAIL_HOST === 'localhost') {
        console.log('[missing-data-alert] Email config not set, logging instead:');
        console.log('Subject:', subject);
        console.log('Body:\n', body);
        return;
    }

    const transporter = nodemailer.createTransport({
        host: EMAIL_HOST,
        port: EMAIL_PORT,
        secure: EMAIL_SECURE,
        auth: EMAIL_USER && EMAIL_PASS ? {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        } : undefined
    });

    await transporter.sendMail({
        from: EMAIL_FROM,
        to: EMAIL_TO,
        subject: subject,
        text: body
    });
}

// Run the check
checkMissingData().catch(e => {
    console.error('[missing-data-alert] fatal error:', e);
    process.exit(1);
});
