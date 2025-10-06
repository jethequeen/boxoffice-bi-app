// cineEntrepriseSeats.js
import { chromium } from 'playwright';

const DEFAULTS = {
    headless: true,
    timeoutMs: 120_000,
    selectors: {
        // Buy page
        showtimeContainer: '[data-bind*="Sessions"], .buy__sessions, .session-times',
        showtimeButton: 'a, button',

        // Cart seat-map
        seatBase: '.seat-map__seat',
        seatOccupied: '.seat-map__seat--occupied',
        seatBlocked: '.seat-map__seat--house',
        seatWheelchair: '.seat-map__seat--wheelchair',
        seatMapReady: '.seat-map, .seat-map__legend, .seat-map__seat',

        // Cinema selector on buy page header
        cinemaSelectorButton: 'cinema-selector .header-top__location',
        cinemaSelectorOption: '.modal [data-cinema], .cinema-selector__item, [role="dialog"] [data-cinema]',
    },
};

// Scopes to the bottom form block
const FORM_ROOT = '.buy-page__bottom-section .purchase-tickets__form-select.std-select';

const norm = s => (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Select an option inside a cine-select by its label ("FILMS" | "CINÉMA" | "JOURNÉE")
 * optionText is the visible label (movie title, theater name, or M/D/YYYY).
 */
async function selectFromCineSelect(page, groupLabel, optionText, { timeoutMs = 60000 } = {}) {
    // Find the specific select whose <label> text matches groupLabel
    const SELECT = await page.$$(`${FORM_ROOT}`);
    let rootLocator = null;

    for (const i in SELECT) {
        const root = page.locator(FORM_ROOT).nth(i);
        const lab  = root.locator('.floatl__label, label');
        const txt  = (await lab.textContent().catch(() => '')) || '';
        if (norm(txt) === norm(groupLabel)) { rootLocator = root; break; }
    }
    if (!rootLocator) throw new Error(`cine-select "${groupLabel}" not found`);

    const btn    = rootLocator.locator('.std-select__button').first();
    const list   = rootLocator.locator('.std-select__options'); // <ul>
    const labels = rootLocator.locator('.std-select__options-item .std-select__options-item-label');

    // If already selected, skip
    const current = (await rootLocator.locator('.std-select__button-text').first().textContent().catch(() => ''))?.trim();
    if (current && norm(current) === norm(optionText)) return true;

    // Open the dropdown (may need two clicks depending on state)
    await btn.click();
    if (!(await list.isVisible().catch(() => false))) {
        await btn.click();
    }
    await list.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});

    // Try direct hasText first
    let target = labels.filter({ hasText: optionText }).first();
    if (!(await target.count())) {
        // Fallback: normalize text in-page, return index, then click by nth()
        const idx = await page.$$eval(
            `${FORM_ROOT} .std-select__options-item .std-select__options-item-label`,
            (nodes, optText, formRoot, group) => {
                const N = s => (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/\s+/g,' ').trim();
                // Find the exact cine-select first (by <label> text)
                const roots = Array.from(document.querySelectorAll(formRoot));
                let chosenRoot = null;
                for (const r of roots) {
                    const lab = r.querySelector('.floatl__label, label');
                    if (N(lab?.textContent) === N(group)) { chosenRoot = r; break; }
                }
                if (!chosenRoot) return -1;
                const opts = chosenRoot.querySelectorAll('.std-select__options-item .std-select__options-item-label');
                for (let i = 0; i < opts.length; i++) {
                    const t = N(opts[i].textContent) || N(opts[i].getAttribute('title'));
                    if (t === N(optText)) return i;
                }
                return -1;
            },
            optionText, FORM_ROOT, groupLabel
        );

        if (idx === -1) throw new Error(`Option "${optionText}" not found in "${groupLabel}"`);
        target = labels.nth(idx);
    }

    await target.click();
    // Let Knockout apply selection (session list refresh etc.)
    await page.waitForTimeout(400);
    return true;
}

// Convenience wrappers
async function selectCinema(page, theaterName) {
    return selectFromCineSelect(page, 'CINÉMA', theaterName);
}
async function selectFilm(page, movieTitle) {
    return selectFromCineSelect(page, 'FILMS', movieTitle);
}


export async function getSeatCountsForShow(theaterName, movieTitle, timeHHMM, dayLabel, opts = {}) {
    const browser = await chromium.launch({ headless: false, ...(opts.launch || {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const cfg = {
        ...DEFAULTS,
        ...opts,
        selectors: { ...DEFAULTS.selectors, ...(opts.selectors || {}) },
    };

    try {
        await page.goto('https://www.cinentreprise.com/buy-page', { waitUntil: 'networkidle' });

        // Use the form (no header modal needed)
        await ensureCinema(page, theaterName, cfg)
        await selectFilm(page, movieTitle);
        await selectDay(page, dayLabel);

        // Small settle to let showtimes populate
        await page.waitForTimeout(500);

        // Click the exact time -> cart
        await clickShowtime(page, timeHHMM, {
            selectors: {
                showtimeContainer: '[data-bind*="Sessions"], .buy__sessions, .session-times',
                showtimeButton: 'a, button',
            },
            timeoutMs: 120000,
        });

        // Wait seatmap & count
        await page.waitForSelector('.seat-map, .seat-map__legend, .seat-map__seat', { timeout: 120000 });
        const counts = await countSeats(page, {
            selectors: {
                seatBase: '.seat-map__seat',
                seatOccupied: '.seat-map__seat--occupied',
                seatBlocked: '.seat-map__seat--house',
                seatWheelchair: '.seat-map__seat--wheelchair',
            }
        });

        return { theater: theaterName, movie: movieTitle, time: timeHHMM, ...counts, urlVisited: page.url() };
    } finally {
        await browser.close();
    }
}


/* ------------------ helpers ------------------ */

async function ensureCinema(page, theaterName, cfg) {
    const MODAL_OPEN = '.remodal-wrapper.cinemaSelector.remodal-is-opened';
    const BTN_OPEN   = cfg.selectors.cinemaSelectorButton;

    // 1) Open the selector modal if it's not already open
    const modalOpen = async () => await page.locator(MODAL_OPEN).isVisible().catch(() => false);
    if (!(await modalOpen())) {
        await page.locator(BTN_OPEN).first().click();
        await page.waitForSelector(MODAL_OPEN, { timeout: cfg.timeoutMs });
    }

    // 2) Click the cinema option inside the open modal
    // Preferred: ARIA role lookup by accessible name (handles most whitespace nicely)
    const modal = page.locator(MODAL_OPEN);

    // Try exact / case-insensitive name first
    const escaped = theaterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(escaped, 'i');

    let target = modal.getByRole('button', { name: nameRe }).first();

    if (!(await target.count())) {
        // Fallback: CSS + hasText filter on the concrete selector you shared
        target = modal.locator('button.cinema-selector__list-item-button').filter({ hasText: theaterName }).first();
    }

    // As a final fallback, do a text-normalized search in the modal to find index, then click by nth()
    if (!(await target.count())) {
        const idx = await modal.$$eval('button.cinema-selector__list-item-button', (nodes, needle) => {
            const norm = s => (s || '')
                .toLowerCase()
                .normalize('NFD').replace(/\p{Diacritic}/gu, '')
                .replace(/\s+/g, ' ')
                .trim();
            const wanted = norm(needle);
            for (let i = 0; i < nodes.length; i++) {
                if (norm(nodes[i].textContent).includes(wanted)) return i;
            }
            return -1;
        }, theaterName);

        if (idx === -1) {
            throw new Error(`Cinema not found in selector modal: "${theaterName}"`);
        }
        await modal.locator('button.cinema-selector__list-item-button').nth(idx).click();
    } else {
        await target.click();
    }

    // Small settle; site usually closes the modal / updates header
    await page.waitForTimeout(300);
}




async function openMovieOnBuyPage(page, movieTitle, cfg) {
    const needle = normalize(movieTitle);

    // Try obvious clickable elements on the buy page
    const candidates = await page.$$('a, button, [role="button"], .movie, .film, .card');
    for (const el of candidates) {
        const t = (await el.textContent())?.trim() ?? '';
        if (normalize(t).includes(needle)) {
            await el.scrollIntoViewIfNeeded();
            try {
                await el.click({ timeout: 2000 });
                break;
            } catch {
                // keep scanning others
            }
        }
    }

    // Let sessions render (if on same page)
    await page.waitForTimeout(500);
}


// Select HH:MM, then wait for the CTA to appear and click it.
// Works with the radio+label KO binding you pasted.
async function clickShowtime(page, hhmm, { timeoutMs = 60000 } = {}) {
    // 0) Wait for the time row to exist
    const row = page.locator('.time-row').first();
    await row.waitFor({ state: 'visible', timeout: timeoutMs });

    // 1) Find the label with exact text and its radio via "for"
    const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const label = row.locator(`label.buy-page__showtimes-time-select-label:has-text(/^${esc(hhmm)}$/)`).first();
    if (!(await label.count())) {
        const avail = await row.locator('label.buy-page__showtimes-time-select-label').allTextContents();
        throw new Error(`Showtime "${hhmm}" not found. Available: ${avail.map(s => s.trim()).join(', ')}`);
    }
    const forId = await label.getAttribute('for');
    if (!forId) throw new Error(`Label for "${hhmm}" has no 'for' attribute`);
    const radio = page.locator(`input.buy-page__showtimes-time-select-radio#${forId}`).first();

    // 2) In-page: force-select the radio and fire the event sequence KO listens for
    const forced = await page.evaluate((rid) => {
        const r = document.getElementById(rid);
        if (!(r instanceof HTMLInputElement)) return false;
        const lab = document.querySelector(`label[for="${rid}"]`);
        // ensure it is in view
        r.scrollIntoView({ block: 'center', inline: 'center' });
        if (lab) lab.scrollIntoView({ block: 'center', inline: 'center' });

        // set the value KO 'checked:' binding observes
        r.checked = true;

        // dispatch events in the order many KO bindings expect
        r.dispatchEvent(new Event('input',  { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
        // also trigger the label click path in case handler is attached there
        if (lab) {
            lab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return true;
    }, forId);
    if (!forced) throw new Error(`Unable to access radio for "${hhmm}"`);

    // 3) Verify the radio actually became checked
    await page.waitForFunction(
        (rid) => {
            const el = document.getElementById(rid);
            return el && el instanceof HTMLInputElement && el.checked === true;
        },
        forId,
        { timeout: timeoutMs }
    );

    // 4) Wait for the CTA to appear (different site variants use different text/selectors)
    const ctaSelector = [
        '.buy-page__showtimes-cta button',          // common wrapper on this site
        'button:has-text("Acheter")',
        'button:has-text("Continuer")',
        'button:has-text("Poursuivre")',
        'a:has-text("Acheter")'
    ].join(', ');
    const cta = page.locator(ctaSelector).first();

    await cta.waitFor({ state: 'visible', timeout: timeoutMs })
        .catch(async () => {
            // If no CTA, some variants auto-nav to cart/seatmap; check that too.
            const auto = await Promise.race([
                page.waitForURL(/\/cart/i, { timeout: 1000 }).then(() => true).catch(() => false),
                page.waitForSelector('.seat-map, .seat-map__legend, .seat-map__seat', { timeout: 1000 }).then(() => true).catch(() => false),
            ]);
            if (!auto) throw new Error('CTA did not appear and no auto-navigation after selecting showtime.');
        });

    // 5) If we have a CTA, click it and proceed to cart/seatmap
    if (await cta.count()) {
        await cta.scrollIntoViewIfNeeded().catch(() => {});
        try {
            await cta.click({ timeout: 2000 });
        } catch {
            // native click fallback
            await cta.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        }

        // Final wait for destination
        await Promise.race([
            page.waitForURL(/\/cart/i, { timeout: timeoutMs }),
            page.waitForSelector('.seat-map, .seat-map__legend, .seat-map__seat', { timeout: timeoutMs }),
        ]);
    }

    return true;
}



async function countSeats(page, cfg) {
    return page.evaluate((s) => {
        const count = (sel) => document.querySelectorAll(sel).length;

        const occupied   = count(s.seatOccupied);
        const blocked    = count(s.seatBlocked);
        const wheelchair = count(s.seatWheelchair);
        const sellable   = count(`${s.seatBase}:not(${s.seatBlocked}):not(${s.seatWheelchair})`);
        const remaining  = sellable - occupied;

        return { sellable, occupied, remaining, blocked, wheelchair };
    }, cfg.selectors);
}

// Click the JOURNÉE dropdown, then select the option.
// If `wanted` provided (e.g. "10/6/2025"), choose that; otherwise click FIRST option.
async function selectDay(page, wanted /* string or null */, { timeoutMs = 60000 } = {}) {
    // --- locate the JOURNÉE select root ---
    const root = page.locator(
        '.buy-page__bottom-section .purchase-tickets__form-select.std-select:has(.floatl__label:has-text("JOURNÉE"))'
    ).first();

    await root.waitFor({ state: 'visible', timeout: timeoutMs });

    const btn      = root.locator('button.std-select__button:not([disabled])').first(); // ensure not disabled
    const list     = root.locator('.std-select__options'); // the <ul> options
    const btnText  = root.locator('.std-select__button-text').first();

    // tiny helper: is open?
    async function isOpen() {
        const hasClass = await root.evaluate(el => el.classList.contains('std-select--open')).catch(() => false);
        const listVisible = await list.isVisible().catch(() => false);
        return hasClass || listVisible;
    }

    // --- 1) OPEN the dropdown robustly ---
    // Sometimes the component needs a couple of nudges. Try multiple strategies.
    async function tryOpen() {
        // wait until the button is truly visible & enabled
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.waitFor({ state: 'visible', timeout: timeoutMs });

        // A) normal click
        try { await btn.click({ timeout: 1000 }); } catch {}
        if (await isOpen()) return true;

        // B) press Enter
        try { await btn.press('Enter'); } catch {}
        if (await isOpen()) return true;

        // C) press Space
        try { await btn.press(' '); } catch {}
        if (await isOpen()) return true;

        // D) JS click (bypass hit-target heuristics)
        try {
            await btn.evaluate(el => {
                el.scrollIntoView({ block: 'center', inline: 'center' });
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
        } catch {}
        if (await isOpen()) return true;

        // E) forced click as last resort
        try { await btn.click({ force: true, timeout: 1000 }); } catch {}
        return await isOpen();
    }

    const opened = await tryOpen();
    if (!opened) throw new Error('JOURNÉE dropdown did not open');

    // Make sure list is visible now
    await list.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});

    // --- 2) Choose the option link (wrapper fires KO itemClick) ---
    let link;
    if (wanted) {
        // prefer by title exact match
        link = root.locator(
            `.std-select__options-item .std-select__options-item-link:has(.std-select__options-item-label[title="${wanted}"])`
        ).first();
        if (!(await link.count())) {
            // fallback by visible text
            link = root.locator(
                `.std-select__options-item .std-select__options-item-link:has(.std-select__options-item-label:has-text("${wanted}"))`
            ).first();
        }
    }

    if (!wanted || !(await link.count())) {
        // default to FIRST option link, per your note (most common case)
        link = root.locator('.std-select__options-item .std-select__options-item-link').first();
    }

    await link.scrollIntoViewIfNeeded().catch(() => {});
    try {
        await link.click({ timeout: 1500 });
    } catch {
        // fallback: in-page click to ensure KO handler fires
        await link.evaluate(el => {
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
    }

    // --- 3) Verify selection reflected in button text ---
    if (wanted) {
        await page.waitForFunction(
            (el, expected) => !!el && el.textContent && el.textContent.trim() === expected,
            await btnText.elementHandle(),
            wanted,
            { timeout: timeoutMs }
        );
    } else {
        const before = (await btnText.textContent() || '').trim();
        await page.waitForFunction(
            (el, prev) => !!el && el.textContent && el.textContent.trim() !== prev,
            await btnText.elementHandle(),
            before,
            { timeout: timeoutMs }
        );
    }

    // breathe so sessions repopulate
    await page.waitForTimeout(300);
    return true;
}




/* ------------------ utils ------------------ */

function normalize(s) {
    return s
        .toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}
