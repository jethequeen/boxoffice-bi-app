// test/cancel_after_confirm.js
import fetch from "node-fetch";
import { postCancelStrict, setVerbose } from "../helpers/cancelTickets.js";

setVerbose(true);

const TARGET =
    process.env.TARGET_URL ||
    "https://billets.lamaisonducinema.com/FR/Film-achat.awp?P1=01&P2=01&P3=125097";
const EMAIL = process.env.PROBE_EMAIL || "probe@example.com";
const NAME  = process.env.PROBE_NAME  || "Probe";
const Q     = Number(process.env.Q || 2);

let COOKIE = "";

// simple cookie merge
function mergeCookies(oldCookie = "", setCookieHeader = "") {
    const jar = new Map();
    const add = (kv) => { const [k,v] = kv.split("=",2); if (k && v) jar.set(k.trim(), v.trim()); };
    oldCookie.split(";").map(s=>s.trim()).filter(Boolean).forEach(add);
    setCookieHeader.split(/,(?=[^;]+?=)/).forEach(sc => add(sc.split(";")[0]));
    return [...jar.entries()].map(([k,v]) => `${k}=${v}`).join("; ");
}

async function primingGet() {
    const r = await fetch(TARGET, { redirect:"follow" });
    COOKIE = mergeCookies(COOKIE, r.headers.get("set-cookie") || "");
    COOKIE = mergeCookies(COOKIE, "wbNavigateurLargeur=803");
}

function buildSubmitBody(q) {
    const p = new URLSearchParams();
    p.set("WD_JSON_PROPRIETE_", JSON.stringify({
        m_oProprietesSecurisees:{}, m_oChampsModifies:{A9:true}, m_oVariablesProjet:{}, m_oVariablesPage:{}
    }));
    p.set("WD_BUTTON_CLICK_","A12"); p.set("WD_ACTION_","");
    p.set("A13","1"); p.set("A13_DEB","1"); p.set("_A13_OCC","5");
    p.set("zrl_1_A41", String(q)); p.set("zrl_1_A53","");
    p.set("zrl_2_A41","0"); p.set("zrl_3_A41","0"); p.set("zrl_4_A41","0"); p.set("zrl_5_A41","0");
    p.set("A9", EMAIL); p.set("A10", EMAIL); p.set("A62", NAME);
    for (const k of ["A58","A54","A39","A43","A46","A48","A52","A50","A51"]) p.set(k,"");
    return p.toString();
}

async function postSubmit(bodyStr) {
    const headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": new URL(TARGET).origin,
        "Referer": TARGET,
        "Cookie": COOKIE
    };
    const res = await fetch(TARGET, { method: "POST", headers, body: bodyStr, redirect: "follow" });
    COOKIE = mergeCookies(COOKIE, res.headers.get("set-cookie") || "");
    const html = await res.text();
    return { status: res.status, html };
}

(async () => {
    await primingGet();

    // 1) reserve Q (land on PAGE_VENTE_CONFIRMATION)
    const r1 = await postSubmit(buildSubmitBody(Q));
    if (!/PAGE_VENTE_CONFIRMATION/i.test(r1.html)) {
        console.log("Did not reach confirmation; nothing to cancel.");
        return;
    }

    // 2) cancel with STRICT helper (reuses the same cookie jar)
    const out = await postCancelStrict({
        confirmHtml: r1.html,
        baseUrl: TARGET,
        cookie: COOKIE
    });

    console.log("cancel →", {
        ok: out.ok,
        status: out.status,
        reason: out.reason,
        confirmUrl: out.confirmUrl,
        saved: out.saved
    });
})();
