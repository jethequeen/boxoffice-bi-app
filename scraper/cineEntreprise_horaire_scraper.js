// cineEntreprise_fromSchedule.fast.js
import { chromium } from 'playwright';

const SEL = {
    cookieAccept: 'button[data-cky-tag="accept-button"], .cky-btn-accept',

    // schedule (card + times)
    card: 'section.cinema-details__film-listing-item.movie-badge',
    cardTitle: '.movie-badge__content-main-title',
    timeBtn: '.movie-badge__content-main-times .time-row__buttons button, .add-ticket-modal-btn button',

    // modal -> proceed as guest
    modalOpen: '.remodal.remodal-is-opened, .login-signup',
    proceedGuest: 'button, a',

    // add tickets modal
    addTicketsModal: '.remodal.remodal-is-opened.addTickets',
    ticketRow: '.cart__validation-ticket-info-content-row',
    plusBtn: 'button.std-number__plus',
    qtyInput: 'input.std-number__text',
    addToCart: 'button.cart-validation__proceed-payment-button, a.cart-validation__proceed-payment-button',

    // seat map
    seatMapReady: '.seat-map, .seat-map__legend, .seat-map__seat',
    seatBase: '.seat-map__seat',
    seatOccupied: '.seat-map__seat--occupied',
    seatBlocked: '.seat-map__seat--house',
    seatWheelchair: '.seat-map__seat--wheelchair'
};

const N = s => (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export async function getSeatCountsFromSchedule(cinemaSlug, theaterName, movieTitle, dateLabel, timeHHMM, opts = {}) {
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
        ...(opts.launch || {}),
    });

    const acceptLang = process.env.CE_ACCEPT_LANG || 'fr-CA,fr;q=0.9,en;q=0.8';
    const blockAssets = (process.env.CE_BLOCK_ASSETS ?? '1') !== '0';
    const defaultTimeout = parseInt(process.env.CE_TIMEOUT_MS || '45000', 10);

    const context = await browser.newContext({
        locale: 'fr-CA',
        timezoneId: 'America/Toronto',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        extraHTTPHeaders: { 'Accept-Language': acceptLang },
    });

    // Single, consolidated route filter (avoid double registration)
    if (blockAssets) {
        await context.route('**/*', route => {
            const t = route.request().resourceType();
            if (t === 'image' || t === 'font' || t === 'media') return route.abort();
            return route.continue();
        });
    }

    const page = await context.newPage();
    page.setDefaultTimeout(defaultTimeout);
    page.setDefaultNavigationTimeout(defaultTimeout);

    try {
        const url = encodeURI(`https://www.cinentreprise.com/cinemas/${cinemaSlug}/horaires`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });

        await Promise.race([
            page.waitForLoadState('networkidle', { timeout: 15_000 }),
            page.waitForTimeout(15_000),
        ]);

        // cookie
        const cookie = page.locator(SEL.cookieAccept).first();
        if (await cookie.isVisible().catch(() => false)) await cookie.click().catch(() => {});

        // click wanted time inside the movie card
        await clickScheduleShowtime(page, movieTitle, timeHHMM);

        // let KO/Remodal attach
        await Promise.race([
            page.waitForLoadState('networkidle', { timeout: 8_000 }),
            page.waitForTimeout(2_000),
        ]);

        // dismiss visitor gate if it appears
        await dismissVisitorGate(page);

        // add tickets fast (1 by default) and continue
        await addTicketsThenContinueFast(page, 1);

        // confirm “OUI” if present, but don’t throw if it isn’t
        await confirmProceedYesFast(page);

        // ---- seat-map/cart race, then count -----------------------------------
        const where = await Promise.race([
            page.waitForSelector(SEL.seatMapReady, { timeout: 60_000 }).then(() => 'seat'),
            page.waitForURL(/\/cart\b/i, { timeout: 60_000 }).then(() => 'cart').catch(() => null),
        ]).catch(() => null);

        // If we landed on cart, the seat map often still renders there; give it a brief chance
        if (where !== 'seat') {
            await page.waitForSelector(SEL.seatMapReady, { timeout: 30_000 }).catch(() => {});
        }

        const counts = await countSeats(page); // works whether on seat page or cart (when map exists)

        const measured_at = new Date().toISOString();
        return {
            theater: theaterName,
            movie: movieTitle,
            date: dateLabel,
            time: timeHHMM,
            sellable: counts.sellable,
            occupied: counts.occupied,
            blocked: counts.blocked,
            wheelchair: counts.wheelchair,
            // daemon compatibility fields (CHANGED)
            seats_remaining: counts.remaining,
            measured_at,
            source: 'cineentreprise',
            urlVisited: page.url(),
        };
    } catch (e) {
        try {
            const ts = Date.now();
            await page.screenshot({ path: `/tmp/ce_${ts}.png`, fullPage: true });
            const html = await page.content();
            await import('fs/promises').then(fs => fs.writeFile(`/tmp/ce_${ts}.html`, html));
        } catch {}
        throw e;
    } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

/* ---------------- helpers ---------------- */

async function clickScheduleShowtime(page, movieTitle, timeHHMM) {
    await page.waitForSelector(SEL.card, { timeout: 80_000 });

    // find card by title
    const cards = page.locator(SEL.card);
    const n = await cards.count();
    let idx = -1;
    for (let i = 0; i < n; i++) {
        const t = await cards.nth(i).locator(SEL.cardTitle).first().textContent().catch(() => '');
        if (t && (N(t) === N(movieTitle) || N(t).includes(N(movieTitle)))) { idx = i; break; }
    }
    if (idx < 0) throw new Error(`Movie "${movieTitle}" not found on schedule`);

    const card = cards.nth(idx);
    const timeRe = new RegExp(`^\\s*${timeHHMM.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(':', '\\s*:\\s*')}\\s*$`);

    // role-based button first, fallback to generic
    let btn = card.getByRole('button', { name: timeRe }).first();
    if (!(await btn.count())) {
        btn = card.locator(SEL.timeBtn).filter({ hasText: timeRe }).first();
    }
    if (!(await btn.count())) throw new Error(`Showtime "${timeHHMM}" not found for "${movieTitle}"`);

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    try { await btn.click({ timeout: 1200 }); }
    catch {
        try { await btn.click({ force: true, timeout: 1200 }); }
        catch { await btn.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
    }
}

async function dismissVisitorGate(page) {
    const modal = page.locator(SEL.modalOpen).first();
    try {
        await modal.waitFor({ state: 'visible', timeout: 8_000 });
    } catch {
        return; // Modal didn’t appear — nothing to do.
    }

    // “Procéder en tant que visiteur.”
    const guestRe = /proc(é|e)der en tant que visiteur\.?/i;
    let btn = modal.getByRole('button', { name: guestRe }).first();
    if (!(await btn.count())) btn = modal.locator(SEL.proceedGuest).filter({ hasText: guestRe }).first();

    if (await btn.count()) {
        try { await btn.click({ timeout: 1200 }); }
        catch {
            try { await btn.click({ force: true, timeout: 1200 }); }
            catch { await btn.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
        }
    }

    // iframe variant (rare)
    for (const frame of page.frames()) {
        if (frame !== page.mainFrame() && /login|auth|remodal/i.test(frame.url())) {
            try {
                const iframeBtn = frame.getByRole('button', { name: guestRe }).first();
                if (await iframeBtn.count()) await iframeBtn.click({ timeout: 2_000 });
            } catch {}
        }
    }

    await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {}),
        page.waitForTimeout(2_000),
    ]);
}

async function addTicketsThenContinueFast(page, count = 1) {
    const modal = page.locator(SEL.addTicketsModal).first();
    await modal.waitFor({ state: 'visible', timeout: 60_000 });


// ✅ good: CSS + hasText filter
    let row = modal.locator(SEL.ticketRow).filter({ hasText: /Adulte|Adult/i }).first();
    if (!(await row.count())) row = modal.locator(SEL.ticketRow).first();


    const plus = row.locator(SEL.plusBtn).first();
    const qty  = row.locator(SEL.qtyInput).first();

    await plus.waitFor({ state: 'visible', timeout: 3_000 });

    for (let i = 0; i < count; i++) {
        try { await plus.click({ timeout: 400 }); }
        catch {
            try { await plus.click({ force: true, timeout: 400 }); }
            catch { await plus.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
        }
        await page.waitForTimeout(120);
    }

    await page.waitForFunction(
        el => {
            const v = (el.value || '').toString().replace(/\D+/g, '');
            return parseInt(v || '0', 10) > 0;
        },
        await qty.elementHandle(),
        { timeout: 3_000 }
    ).catch(() => {});

    const cta = modal.locator(SEL.addToCart).first();
    await cta.waitFor({ state: 'visible', timeout: 8_000 });
    await page.waitForFunction(
        el => el && !el.hasAttribute('disabled') && (el.getAttribute('aria-disabled') !== 'true'),
        await cta.elementHandle(),
        { timeout: 6_000 }
    ).catch(() => {});

    try { await cta.click({ timeout: 1200 }); }
    catch { await cta.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
}

async function confirmProceedYesFast(page, { timeoutMs = 20_000 } = {}) {
    // Tolerant: sometimes the modal is already gone
    const modal = page.locator('.remodal.remodal-is-opened.addTickets').first();
    const visible = await modal.isVisible().catch(() => false);

    if (visible) {
        const successText = modal.locator('text=Voulez-vous procéder au paiement?');
        const yesByRole   = modal.getByRole('button', { name: /^OUI$/i }).first();
        const yesFallback = modal.locator('button.std-button').filter({ hasText: /^OUI$/i }).first();

        await Promise.race([
            successText.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {}),
            yesByRole.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {}),
            yesFallback.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {}),
        ]);

        let yes = (await yesByRole.count()) ? yesByRole : yesFallback;
        if (await yes.count()) {
            try { await yes.click({ timeout: 1200 }); }
            catch {
                try { await yes.click({ force: true, timeout: 1200 }); }
                catch { await yes.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
            }
        }

        await Promise.race([
            modal.waitFor({ state: 'hidden', timeout: timeoutMs }).catch(() => {}),
            page.waitForURL(/\/cart/i, { timeout: timeoutMs }).catch(() => {}),
            page.waitForSelector(SEL.seatMapReady, { timeout: timeoutMs }).catch(() => {}),
        ]);
    }
}

async function countSeats(page) {
    return page.evaluate((s) => {
        const q = (sel) => document.querySelectorAll(sel).length;
        const rawOccupied = q(s.seatOccupied);
        const occupied    = Math.max(0, rawOccupied - 1); // legend often uses occupied class once
        const blocked     = q(s.seatBlocked);
        const wheelchair  = q(s.seatWheelchair);
        const sellable    = q(`${s.seatBase}:not(${s.seatBlocked}):not(${s.seatWheelchair})`);
        const remaining   = sellable - occupied;
        return { sellable, occupied, remaining, blocked, wheelchair };
    }, SEL);
}
