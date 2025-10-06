// cineEntreprise_fromSchedule.fast.js
import { chromium } from 'playwright';

const SEL = {
    cookieAccept: 'button[data-cky-tag="accept-button"], .cky-btn-accept',

    // schedule (card + times)
    card: 'section.cinema-details__film-listing-item.movie-badge',
    cardTitle: '.movie-badge__content-main-title',
    timeBtn: '.movie-badge__content-main-times .time-row__buttons button, add-ticket-modal-btn button',

    // modal -> proceed as guest
    modalOpen: '.remodal.remodal-is-opened, .login-signup',
    proceedGuest: 'button, a',

    // add tickets modal
    addTicketsModal: '.remodal.remodal-is-opened.addTickets',
    ticketRow: '.cart__validation-ticket-info-content-row',
    plusBtn: 'button.std-number__plus',
    qtyInput: 'input.std-number__text',
    addToCart: 'button.cart-validation__proceed-payment-button, a.cart-validation__proceed-payment-button',

    // success confirm
    confirmYes: 'button.std-button',

    // seat map
    seatMapReady: '.seat-map, .seat-map__legend, .seat-map__seat',
    seatBase: '.seat-map__seat',
    seatOccupied: '.seat-map__seat--occupied',
    seatBlocked: '.seat-map__seat--house',
    seatWheelchair: '.seat-map__seat--wheelchair'
};

const N = s => (s||'').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/\s+/g,' ').trim();

export async function getSeatCountsFromSchedule(cinemaSlug, theaterName, movieTitle, dateLabel, timeHHMM, opts = {}) {
    const browser = await chromium.launch({ headless: true, ...opts.launch });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    // small perf win: skip images/fonts
    await context.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'font') route.abort(); else route.continue();
    });

    try {
        const url = encodeURI(`https://www.cinentreprise.com/cinemas/${cinemaSlug}/horaires`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });

        // cookie
        const cookie = page.locator(SEL.cookieAccept).first();
        if (await cookie.isVisible().catch(()=>false)) await cookie.click().catch(()=>{});

        // click wanted time inside the movie card
        await clickScheduleShowtime(page, movieTitle, timeHHMM);

        // proceed as guest
        await proceedAsGuest(page);

        // add tickets fast (1 by default)
        await addTicketsThenContinueFast(page, 1);

        // confirm "Oui"
        await confirmProceedYesFast(page);

        // seatmap + count
        await page.waitForSelector(SEL.seatMapReady, { timeout: 120_000 });
        const counts = await countSeats(page);

        return {
            theater: theaterName,
            movie: movieTitle,
            date: dateLabel,
            time: timeHHMM,
            ...counts,
            urlVisited: page.url()
        };
    } finally {
        // ensure everything closes
        await page.close().catch(()=>{});
        await context.close().catch(()=>{});
        await browser.close().catch(()=>{});
    }
}

/* ---------------- helpers (fast) ---------------- */

async function clickScheduleShowtime(page, movieTitle, timeHHMM) {
    await page.waitForSelector(SEL.card, { timeout: 60000 });

    // find card by title
    const cards = page.locator(SEL.card);
    const n = await cards.count();
    let i = 0, idx = -1;
    for (; i < n; i++) {
        const t = await cards.nth(i).locator(SEL.cardTitle).first().textContent().catch(()=> '');
        if (t && (N(t) === N(movieTitle) || N(t).includes(N(movieTitle)))) { idx = i; break; }
    }
    if (idx < 0) throw new Error(`Movie "${movieTitle}" not found on schedule`);

    const card = cards.nth(idx);
    const timeRe = new RegExp(`^\\s*${timeHHMM.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&').replace(':','\\s*:\\s*')}\\s*$`);
    let btn = card.getByRole('button', { name: timeRe }).first();
    if (!(await btn.count())) {
        btn = card.locator(SEL.timeBtn).filter({ hasText: timeRe }).first();
    }
    if (!(await btn.count())) throw new Error(`Showtime "${timeHHMM}" not found for "${movieTitle}"`);

    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    try { await btn.click({ timeout: 1200 }); }
    catch { await btn.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
}

async function proceedAsGuest(page) {
    const modal = page.locator(SEL.modalOpen).first();
    await modal.waitFor({ state: 'visible', timeout: 30000 });

    // French “Procéder en tant que visiteur.”
    const guestRe = /proc(é|e)der en tant que visiteur\.?/i;
    let btn = modal.getByRole('button', { name: guestRe }).first();
    if (!(await btn.count())) {
        btn = modal.locator(SEL.proceedGuest).filter({ hasText: guestRe }).first();
    }
    if (!(await btn.count())) throw new Error('Guest button not found');

    try { await btn.click({ timeout: 1200 }); }
    catch {
        try { await btn.click({ force: true, timeout: 1200 }); }
        catch { await btn.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
    }

    // move on (tickets/cart/seatmap)
    await Promise.race([
        page.locator(SEL.addTicketsModal).waitFor({ state: 'visible', timeout: 15000 }),
        page.waitForURL(/\/cart/i, { timeout: 15000 }),
        page.waitForSelector(SEL.seatMapReady, { timeout: 15000 })
    ]).catch(()=>{});
}

async function addTicketsThenContinueFast(page, count = 1) {
    const modal = page.locator(SEL.addTicketsModal).first();
    await modal.waitFor({ state: 'visible', timeout: 20000 });

    // choose "Adulte" row if present, else first
    let row = modal.locator(`${SEL.ticketRow}:has-text("Adulte")`).first();
    if (!(await row.count())) row = modal.locator(SEL.ticketRow).first();

    const plus = row.locator(SEL.plusBtn).first();
    const qty  = row.locator(SEL.qtyInput).first();

    await plus.waitFor({ state: 'visible', timeout: 3000 });

    // quick loop; minimal waits
    for (let i = 0; i < count; i++) {
        try { await plus.click({ timeout: 400 }); }
        catch {
            try { await plus.click({ force: true, timeout: 400 }); }
            catch { await plus.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
        }
        // tiny settle so KO updates
        await page.waitForTimeout(120);
    }

    // wait until qty > 0 (best effort)
    await page.waitForFunction(
        el => {
            const v = (el.value || '').toString().replace(/\D+/g,'');
            return parseInt(v || '0',10) > 0;
        },
        await qty.elementHandle(),
        { timeout: 3000 }
    ).catch(()=>{});

    // CTA
    const cta = modal.locator(SEL.addToCart).first();
    await cta.waitFor({ state: 'visible', timeout: 8000 });
    // wait until enabled-ish
    await page.waitForFunction(
        el => el && !el.hasAttribute('disabled') && (el.getAttribute('aria-disabled')!=='true'),
        await cta.elementHandle(),
        { timeout: 6000 }
    ).catch(()=>{});

    try { await cta.click({ timeout: 1200 }); }
    catch { await cta.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
}

// Click "Oui" on the success modal (Remodal), then wait for cart/seatmap.
async function confirmProceedYesFast(page, { timeoutMs = 20000 } = {}) {
    // Wait for the open addTickets modal
    const modal = page.locator('.remodal.remodal-is-opened.addTickets').first();
    await modal.waitFor({ state: 'visible', timeout: timeoutMs });

    // Success state: text + Oui button can appear slightly later than the modal itself
    const successText = modal.locator('text=Voulez-vous procéder au paiement?');
    const yesByRole   = modal.getByRole('button', { name: /^OUI$/i }).first();
    const yesFallback = modal.locator('button.std-button').filter({ hasText: /^OUI$/i }).first();

    // Wait until either the success text OR an "OUI" button is visible
    await Promise.race([
        successText.waitFor({ state: 'visible', timeout: timeoutMs }).catch(()=>{}),
        yesByRole.waitFor({ state: 'visible', timeout: timeoutMs }).catch(()=>{}),
        yesFallback.waitFor({ state: 'visible', timeout: timeoutMs }).catch(()=>{}),
    ]);

    // Choose whichever locator exists
    let yes = (await yesByRole.count()) ? yesByRole : yesFallback;
    if (!(await yes.count())) {
        throw new Error('Success modal appeared but the "Oui" button was not found.');
    }

    // Click "OUI" robustly
    try { await yes.click({ timeout: 1200 }); }
    catch {
        try { await yes.click({ force: true, timeout: 1200 }); }
        catch { await yes.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
    }

    // Then either the modal closes or we land on cart/seatmap
    await Promise.race([
        modal.waitFor({ state: 'hidden', timeout: timeoutMs }).catch(()=>{}),
        page.waitForURL(/\/cart/i, { timeout: timeoutMs }).catch(()=>{}),
        page.waitForSelector('.seat-map, .seat-map__legend, .seat-map__seat', { timeout: timeoutMs }).catch(()=>{}),
    ]);
}

async function countSeats(page) {
    return page.evaluate((s) => {
        const q = (sel) => document.querySelectorAll(sel).length;
        const rawOccupied = q(s.seatOccupied);
        const occupied    = Math.max(0, rawOccupied - 1);
        const blocked    = q(s.seatBlocked);
        const wheelchair = q(s.seatWheelchair);
        const sellable   = q(`${s.seatBase}:not(${s.seatBlocked}):not(${s.seatWheelchair})`);
        const remaining  = sellable - occupied;
        return { sellable, occupied, remaining, blocked, wheelchair };
    }, SEL);
}
