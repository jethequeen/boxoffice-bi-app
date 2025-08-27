const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const squish = (s) => norm(s).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

function hhmmFromLocal(showStartDateTime) {
    if (!showStartDateTime) return "";
    const t = showStartDateTime.split("T")[1] || "";
    return t.slice(0, 5); // HH:MM
}

function titleDistance(a, bRaw) {
    const A = squish(a), B = squish(bRaw);
    if (!A || !B) return 4;
    if (A === B) return 0;
    if (A.includes(B) || B.includes(A)) return 1;
    // tiny overlap proxy
    const setA = new Set(A), setB = new Set(B);
    let inter = 0; for (const ch of setA) if (setB.has(ch)) inter++;
    const frac = inter / Math.max(1, Math.min(setA.size, setB.size));
    return 3 - Math.min(3, Math.floor(frac * 3)); // 0..3
}

/**
 * candidates: [{ movieName, runtimeInMinutes, languageCode, auditorium, showStartDateTime, ... }]
 */
export function matchSessionFor({
                                    candidates,
                                    wantTime,                // "HH:MM"
                                    wantTitle,               // your DB title (EN/FR; doesn't need to match Cineplex language)
                                    wantRuntime = null,      // integer minutes if available
                                    theatreId = null,
                                    preferredLangCode = null // "FR" | "EN" | null
                                }) {
    const atTime = (candidates || [])
        .map(c => ({
            ...c,
            hhmm: hhmmFromLocal(c.showStartDateTime),
            title: c.movieName || c.title || "",
            runtime: Number(c.runtimeInMinutes) || null,
            lang: c.languageCode || null,
            aud: c.auditorium || ""
        }))
        .filter(c => c.hhmm === wantTime);

    if (atTime.length === 0) {
        return { status: "NOT_FOUND_AT_TIME", theatreId, wantTime, wantTitle };
    }
    if (atTime.length === 1) {
        return { status: "OK", session: atTime[0] };
    }

    // Score tie: lower is better
    const scored = atTime.map(c => {
        let score = 0;

        // 1) runtime (strongest)
        if (wantRuntime != null && c.runtime != null) {
            const diff = Math.abs(c.runtime - wantRuntime);
            if (diff <= 3) score += 0;
            else if (diff <= 6) score += 0.5;
            else if (diff <= 10) score += 1;
            else score += 2;
        } else {
            score += 0.5; // light penalty if missing
        }

        // 2) title similarity
        score += titleDistance(c.title, wantTitle);

        // 3) language preference
        if (preferredLangCode && c.lang && c.lang !== preferredLangCode) {
            score += 0.5;
        }

        return { c, score };
    });

    scored.sort((a, b) => a.score - b.score);

    // If too close to call, surface ambiguity (helps your logs)
    if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 0.25) {
        return {
            status: "AMBIGUOUS_AT_TIME",
            theatreId,
            wantTime,
            wantTitle,
            candidates: scored.slice(0, 3).map(s => ({
                title: s.c.title,
                runtime: s.c.runtime,
                aud: s.c.aud,
                lang: s.c.lang
            }))
        };
    }

    return { status: "OK", session: scored[0].c };
}
