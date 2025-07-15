import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

export async function searchMovie(title, year) {
    const query = encodeURIComponent(title);
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${query}&year=${year}&language=en-US`;

    const res = await fetch(url);
    const json = await res.json();

    return json.results?.[0] || null;
}
