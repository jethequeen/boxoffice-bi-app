// test/cancel_now.js
import { cancelDirect } from "../helpers/cancelTickets.js";

const CONFIRM_URL = "https://billets.lamaisonducinema.com/FR/vente-confirmation.awp?P1=01&P2=01&P3=125112&P4=103328&P5=&AWPIDAC5AB5A9=34F394B23C5B034078B55B02B1555649096EB93B";

const COOKIE =
    "_ga=GA1.1.1457939039.1759691998; _ga_3WMTTL2NV1=GS2.1.s1760037141$o7$g1$t1760037142$j59$l0$h0; " +
    "AWP_CSESSIONAC5AB5A9=34F394B23C5B034078B55B02B1555649096EB93B; " + // <-- your live AWP_CSESSION value
    "wbNavigateurLargeur=1221";               // harmless viewport cookie

const out = await cancelDirect(CONFIRM_URL, COOKIE);
console.log(out);
