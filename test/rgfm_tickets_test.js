// test/probe_remaining_countdown_verbose_fast.js
import fetch from "node-fetch";
import http from "node:http";
import https from "node:https";

// ===== CONFIG =====
const TARGET_URL =
    process.env.TARGET_URL ||
    "https://billetterie.cinemasrgfm.com/FR/Film-achat.awp?P1=01&P2=03&P3=215856";

const START_HIGH  = Number(process.env.START_HIGH || 150);
const MIN_Q       = 1;
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 0);
const EMAIL       = process.env.PROBE_EMAIL || "probe@example.com";
const NAME        = process.env.PROBE_NAME  || "Probe";

// Logging controls
const LOG_JSON  = process.env.LOG_JSON === "1";
const LOG_EVERY = Number(process.env.LOG_EVERY || 50);

// ===== Keep-alive agents =====
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 1 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const AGENT = (url) => url.startsWith("https:") ? httpsAgent : httpAgent;

// ===== Helpers =====
const WD_JSON = {
    m_oProprietesSecurisees: {},
    m_oChampsModifies: { A9: true },
    m_oVariablesProjet: {},
    m_oVariablesPage: {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const joinCookies = (arr) => arr.map((s) => s.split(";")[0]).join("; ");
const nowIso = () => new Date().toISOString();

function logLine(obj) {
    if (LOG_JSON) console.log(JSON.stringify(obj));
    else {
        const { t, ev, ...rest } = obj;
        console.log(`[${t}] ${ev}`, Object.keys(rest).length ? rest : "");
    }
}

async function primingGet() {
    const r = await fetch(TARGET_URL, { redirect: "follow", agent: AGENT(TARGET_URL) });
    const set = r.headers.raw()["set-cookie"] || [];
    set.push("wbNavigateurLargeur=803; Path=/");
    const cookie = joinCookies(set);
    logLine({ t: nowIso(), ev: "primed_cookie", cookie });
    return cookie;
}

// ---------- Fixed RGFM payload builder (no auto-discovery) ----------
function buildBodyRGFM(q) {
    // RGFM rule: _A13_OCC = 4; zrl_1_A23 = q+1; zrl_2/3/4_A23 = 1; companions _A35 blank.
    const p = new URLSearchParams();
    p.set("WD_JSON_PROPRIETE_", JSON.stringify(WD_JSON));
    p.set("WD_BUTTON_CLICK_", "A12");
    p.set("WD_ACTION_", "");

    p.set("A13", "1");
    p.set("A13_DEB", "1");
    p.set("_A13_OCC", "4");

    // Quantities (A23)
    p.set("zrl_1_A23", String(q + 1));
    p.set("zrl_2_A23", "1");
    p.set("zrl_3_A23", "1");
    p.set("zrl_4_A23", "1");

    // Companions (A35) — blank
    p.set("zrl_1_A35", "");
    p.set("zrl_2_A35", "");
    p.set("zrl_3_A35", "");
    p.set("zrl_4_A35", "");

    // Identity/contact
    p.set("A9", EMAIL);
    p.set("A10", EMAIL);
    p.set("A62", NAME);

    // Misc empties
    for (const k of ["A58","A54","A39","A43","A46","A48","A52","A50","A51"]) p.set(k, "");

    return p;
}

/** One POST probe (no follow). */
async function tryQ(cookie, q) {
    const hdr = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": new URL(TARGET_URL).origin,
        "Referer": TARGET_URL,
        "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.8",
        "Cookie": cookie,
        "Connection": "keep-alive"
    };

    const res = await fetch(TARGET_URL, {
        method: "POST",
        headers: hdr,
        body: buildBodyRGFM(q),
        redirect: "manual",
        agent: AGENT(TARGET_URL)
    });

    const loc = res.headers.get("location") || "";
    const ok  = res.status >= 300 && res.status < 400 && /vente-confirmation\.awp/i.test(loc);
    const confirmUrl = ok ? new URL(loc, TARGET_URL).toString() : null;
    return { ok, status: res.status, confirmUrl, location: loc };
}

(async () => {
    const cookie = await primingGet();

    let attempts = 0;
    let successQ = null;
    let successUrl = null;

    for (let q = START_HIGH; q >= MIN_Q; q--) {
        attempts++;
        const res = await tryQ(cookie, q);

        if (attempts % LOG_EVERY === 0) {
            logLine({
                t: nowIso(),
                ev: "probe",
                q,
                status: res.status,
                ok: res.ok,
                has_location: Boolean(res.location),
                location: res.location || null
            });
        }

        if (res.ok) {
            successQ = q;
            successUrl = res.confirmUrl;
            logLine({ t: nowIso(), ev: "success", q: successQ, confirm_url: successUrl });
            break; // stop on first success (holds seats)
        }

        if (COOLDOWN_MS > 0) await sleep(COOLDOWN_MS);
    }

    if (successUrl) {
        console.log("=== SUCCESS ===");
        console.log("Q:", successQ);         // as requested
        console.log("Confirm URL:", successUrl); // absolute, includes P4=…
    } else {
        console.log("No purchasable quantity found in the countdown window.");
    }
})();
