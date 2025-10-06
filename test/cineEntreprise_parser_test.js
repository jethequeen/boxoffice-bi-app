// example.js
import { getSeatCountsFromSchedule } from '../scraper/cineEntreprise_horaire_scraper.js';

const result = await getSeatCountsFromSchedule(
    // cinema slug as it appears in the URL (percent-encoding is okay; function will encode)
    'cinéma-élysée',                  // or 'cin%c3%a9ma-%c3%a9lys%c3%a9e'
    'Cinéma Élysée (Granby)',         // for reporting
    'Le combattant',                 // movie title as shown
    '10/6/2025',                      // day label exactly as the widget lists it
    '21:40',                          // showtime label
    { launch: { headless: true } }   // (optional) show browser
);

console.log(result);
