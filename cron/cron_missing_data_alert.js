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
const CHECK_WINDOW_HOURS = 5; // Check shows from the last 5-hour window
const MISSING_DATA_THRESHOLD = 0.10; // Alert only if 10% or more shows are missing data

async function checkMissingData() {
    const client = getClient();
    await client.connect();

    try {
        // First, count total Cineplex shows in the check window
        const totalQuery = await client.query(`
            SELECT COUNT(*) as total
            FROM showings s
                JOIN theaters t ON t.id = s.theater_id
            WHERE s.start_at < (now() - make_interval(hours => $1))
              AND s.start_at > (now() - make_interval(hours => $2))
              AND t.name LIKE '%Cineplex%'
        `, [ALERT_HOURS_AFTER, ALERT_HOURS_AFTER + CHECK_WINDOW_HOURS]);

        const totalShows = parseInt(totalQuery.rows[0].total, 10);

        if (totalShows === 0) {
            console.log('[missing-data-alert] ✓ No shows in the check window (daemon likely inactive)');
            return;
        }

        // Find shows that started 5+ hours ago (within check window) and still have no seats_sold data
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
        `, [ALERT_HOURS_AFTER, ALERT_HOURS_AFTER + CHECK_WINDOW_HOURS]);

        const missingShows = query.rowCount;
        const missingPercentage = missingShows / totalShows;

        console.log(`[missing-data-alert] Checked ${totalShows} shows, ${missingShows} missing data (${(missingPercentage * 100).toFixed(1)}%)`);

        // Only alert if missing data exceeds threshold
        if (missingPercentage < MISSING_DATA_THRESHOLD) {
            console.log(`[missing-data-alert] ✓ Missing data below ${(MISSING_DATA_THRESHOLD * 100)}% threshold - daemon is healthy`);
            return;
        }

        console.log(`[missing-data-alert] ⚠️ Missing data exceeds ${(MISSING_DATA_THRESHOLD * 100)}% threshold`);

        // Group by theater for better readability
        const byTheater = {};
        for (const row of query.rows) {
            if (!byTheater[row.theater_name]) {
                byTheater[row.theater_name] = [];
            }
            byTheater[row.theater_name].push(row);
        }

        // Build email body
        let emailBody = `⚠️ DAEMON HEALTH CHECK ALERT\n\n`;
        emailBody += `Missing data: ${missingShows} out of ${totalShows} shows (${(missingPercentage * 100).toFixed(1)}%)\n`;
        emailBody += `Threshold: ${(MISSING_DATA_THRESHOLD * 100)}%\n\n`;
        emailBody += `Shows with missing seats_sold data:\n\n`;

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

        emailBody += `\nThis alert checks shows that started ${ALERT_HOURS_AFTER}-${ALERT_HOURS_AFTER + CHECK_WINDOW_HOURS} hours ago.\n`;
        emailBody += `Alert threshold: ${(MISSING_DATA_THRESHOLD * 100)}% missing data (indicates daemon issues)\n`;

        // Send email (or log if no email config)
        await sendAlert(
            `⚠️ Daemon Alert: ${(missingPercentage * 100).toFixed(1)}% of shows missing data (${missingShows}/${totalShows})`,
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
