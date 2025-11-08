// helpers/cancelTickets.js
import fetch from "node-fetch";
import fs from "fs";

/* ===== Verbose ===== */
export const setVerbose = (v) => { globalThis.__ctVerbose = !!v; };
const v = (...a) => globalThis.__ctVerbose && console.log(...a);

/* ===== Cookies ===== */
function mergeCookieString(existingCookie = "", setCookieHeaders = []) {
    const jar = new Map();
    existingCookie.split(";").map(s => s.trim()).filter(Boolean).forEach(kv => {
        const [k, v] = kv.split("="); if (k) jar.set(k, v ?? "");
    });
    for (const raw of (setCookieHeaders || [])) {
        const [nv] = raw.split(";", 1);
        const [k, v] = (nv || "").split("="); if (k) jar.set(k, v ?? "");
    }
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

/* ===== Scrape inputs ===== */
const decode = (s="") => s.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'");
function collectAllInputs(html) {
    const out = new Map();
    const re = /<input\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*>/gi;
    let m; while ((m = re.exec(html))) out.set(decode(m[1]), decode(m[2] ?? ""));
    return out;
}

/* ===== Timer JSON (optional) ===== */
function makeTimerJSON(pageName = "PAGE_VENTE_CONFIRMATION") {
    return JSON.stringify({
        m_oProprietesSecurisees: {},
        m_oChampsModifies: {},
        m_oVariablesProjet: {},
        m_oVariablesPage: { gnUmtimer: { [pageName]: { m_sJSON: "1" } } }
    });
}

/* ===== Build M5 bodies ===== */
function buildM5Body(inputs, { forceA21Zero = false, withTimerJSON = false } = {}) {
    const p = new URLSearchParams();
    // carry everything *exactly* as on the page
    for (const [k, v] of inputs.entries()) p.set(k, v);
    if (forceA21Zero) p.set("A21", "0");
    p.set("WD_BUTTON_CLICK_", "M5");
    p.set("WD_ACTION_", inputs.get("WD_ACTION_") ?? "");
    p.set("WD_JSON_PROPRIETE_", withTimerJSON ? makeTimerJSON("PAGE_VENTE_CONFIRMATION") : "");
    return p.toString();
}

/* ===== POST once ===== */
async function postOnce(url, cookie, body, label) {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": new URL(url).origin,
            "Referer": url,
            "Cookie": cookie
        },
        body,
        redirect: "manual"
    });
    const loc = res.headers.get("location") || "";
    v(`[cancel-azur] ${label} → ${res.status}${loc ? "  Location: " + loc : ""}`);
    return { res, loc };
}

/* ===== Main ===== */
export async function cancelAzurConfirm(confirmUrl, cookie) {
    // 1) GET the confirmation page in the *same session* and merge cookies
    const getRes = await fetch(confirmUrl, {
        headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Cookie": cookie },
        redirect: "follow"
    });
    const set1 = getRes.headers.raw()["set-cookie"] || [];
    cookie = mergeCookieString(cookie, set1);
    const html = await getRes.text();
    const inputs = collectAllInputs(html);

    // Heads-up if we likely lack a server session cookie
    if (!/AWP|ASP|PHPSESSID|JSESSIONID/i.test(cookie)) {
        v("[cancel-azur] Warning: cookie string has no obvious session id. The server may ignore the cancel.");
    }

    // Attempt matrix: only M5 variants
    const attempts = [
        { label: "M5 (as-is)",                    build: () => buildM5Body(inputs, { forceA21Zero: false, withTimerJSON: false }) },
        { label: "M5 (A21=0)",                    build: () => buildM5Body(inputs, { forceA21Zero: true,  withTimerJSON: false }) },
        { label: "M5 (A21=0 + timer JSON)",       build: () => buildM5Body(inputs, { forceA21Zero: true,  withTimerJSON: true  }) },
    ];

    for (const t of attempts) {
        const body = t.build();

        // dump paste-ready PowerShell curl for you
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const curlPS = [
            `curl.exe "${confirmUrl}" \``,
            `  -H 'accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \``,
            `  -H 'content-type: application/x-www-form-urlencoded' \``,
            `  -H 'cookie: ${cookie}' \``,
            `  --data-raw '${body}' \``,
            `  -i -s -k --http1.1`
        ].join("\n");
        try { fs.writeFileSync(`cancel_try_M5_${ts}.txt`, curlPS, "utf8"); } catch {}

        const { res, loc } = await postOnce(confirmUrl, cookie, body, t.label);

        // follow once if redirected
        if (res.status === 302 || res.status === 303) {
            try {
                await fetch(new URL(loc, confirmUrl).toString(), {
                    headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Cookie": cookie },
                    redirect: "follow"
                });
            } catch {}
        }

        // Probe: if basket is gone, confirm URL should error/redirect
        const probe = await fetch(confirmUrl, {
            headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Cookie": cookie },
            redirect: "follow"
        });
        const text = await probe.text();
        const cancelled = probe.status !== 200 || /Erreur dans le code navigateur|Format invalide/i.test(text);
        if (cancelled) return { ok: true, via: t.label, status: res.status, location: loc };
    }

    return { ok: false, status: 0, location: "" };
}
