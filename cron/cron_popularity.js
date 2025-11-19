import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { getClient } from "../db/client.js";
import { refreshPopularity } from "../helpers/refreshPopularity.js";

// ---------- .env loading ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envCandidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../.env"),
];
for (const p of envCandidates) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        break;
    }
}

// ---------- Main Script ----------
(async () => {
    console.log("Starting weekly popularity refresh...");

    const client = getClient();
    await client.connect();

    try {
        // Get all movies from database
        const result = await client.query('SELECT id FROM movies ORDER BY id');
        const movies = result.rows;

        console.log(`Found ${movies.length} movies to refresh`);

        let successCount = 0;
        let skipCount = 0;
        let errorCount = 0;

        // Refresh popularity for each movie
        for (const movie of movies) {
            try {
                const { popularity, skipped } = await refreshPopularity(movie.id);

                if (skipped) {
                    skipCount++;
                    console.log(`⊘ Skipped movie ID ${movie.id} (provisional ID)`);
                } else {
                    successCount++;
                    console.log(`✓ Refreshed movie ID ${movie.id} → popularity: ${popularity}`);
                }

                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                errorCount++;
                console.error(`✗ Error refreshing movie ID ${movie.id}:`, error.message);
                // Continue with next movie even if one fails
            }
        }

        console.log(`\nPopularity refresh complete!`);
        console.log(`  Success: ${successCount}`);
        console.log(`  Skipped: ${skipCount}`);
        console.log(`  Errors:  ${errorCount}`);

    } catch (error) {
        console.error("Fatal error:", error);
        process.exit(1);
    } finally {
        await client.end();
    }

    process.exit(0);
})();
