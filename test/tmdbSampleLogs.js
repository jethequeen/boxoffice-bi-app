import fetch from 'node-fetch';
import fs from 'fs/promises';
import dotenv from 'dotenv';
dotenv.config();

const TMDB_API_KEY = process.env.TMDB_API_KEY;

async function logTMDBSample(title, year) {
    const query = encodeURIComponent(title);
    const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${query}&year=${year}&language=en-US`;

    const searchRes = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    if (!searchJson.results || searchJson.results.length === 0) {
        console.log("❌ Aucun film trouvé.");
        return;
    }

    const match = searchJson.results[0];
    const movieId = match.id;

    const detailsUrl = `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}&language=en-US`;
    const creditsUrl = `https://api.themoviedb.org/3/movie/${movieId}/credits?api_key=${TMDB_API_KEY}`;

    const [detailsRes, creditsRes] = await Promise.all([
        fetch(detailsUrl),
        fetch(creditsUrl)
    ]);

    const details = await detailsRes.json();
    const credits = await creditsRes.json();

    // Enregistre dans un fichier de log lisible
    await fs.writeFile('./tmdb-details.json', JSON.stringify(details, null, 2));
    await fs.writeFile('./tmdb-credits.json', JSON.stringify(credits, null, 2));

    console.log(`✅ Données sauvegardées :\n- tmdb-details.json\n- tmdb-credits.json`);
}

await logTMDBSample("28 Years Later", 2025); // remplace par le film que tu veux tester
