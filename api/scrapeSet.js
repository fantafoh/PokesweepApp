// api/scrapeSet.js
// Fetch a Pikawiz pop-report page by set slug (e.g., baseset, evolvingskies),
// parse each card block, and optionally filter by pokemonName and/or cardNumber.
// Uses "human-like" headers to reduce 403 blocks.

import * as cheerio from "cheerio";

const CANDIDATE_CARD_SELECTORS = [
  ".card",
  ".card-box",
  ".card-item",
  "article",
  "li.card",
  "div[class*='card']",
];

function cleanNum(s) {
  if (!s) return null;
  const m = String(s).replace(/[^\d]/g, "");
  return m ? Number(m) : null;
}

function extractGrades(text) {
  // Finds patterns like "PSA 10 13,782" or "PSA10 13782"
  const grades = {};
  const rx = /PSA\s*([0-9]{1,2})\s*([0-9,]+)/gi;
  let m;
  while ((m = rx.exec(text))) {
    const grade = m[1];
    const val = cleanNum(m[2]);
    if (val != null) grades[`PSA ${grade}`] = val;
  }
  return grades;
}

function extractTotal(text) {
  // "Total Population 18,361"
  const m = /Total\s*Population\s*([0-9,]+)/i.exec(text);
  return m ? cleanNum(m[1]) : null;
}

function extractCardNumberChunk(text) {
  // Grabs things like "215/203" or "4/102"
  const m = /(\d{1,4}\s*\/\s*\d{1,4})/.exec(text);
  return m ? m[1].replace(/\s+/g, "") : null;
}

function extractNameAndDetails($el) {
  const name =
    $el.find("h2").first().text().trim() ||
    $el.find("h3").first().text().trim() ||
    $el.find(".name").first().text().trim() ||
    "";

  const details =
    $el.find("p").first().text().trim() ||
    $el.find(".details").first().text().trim() ||
    "";

  return { name, details };
}

export default async function handler(req, res) {
  const { setSlug, pokemonName, cardNumber, limit } = req.query;

  if (!setSlug) {
    return res
      .status(400)
      .json({ error: "Provide ?setSlug=baseset (or evolvingskies, etc.)" });
  }

  try {
    const slug = String(setSlug).toLowerCase().replace(/\s+/g, "");
    const url = `https://www.pikawiz.com/cards/pop-report/${encodeURIComponent(slug)}`;

    // --- "Human-like" headers to reduce 403s ---
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.pikawiz.com/cards/pop-report",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
      },
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return res.status(r.status).json({
        error: `Failed to fetch set page (${r.status})`,
        url,
        hint:
          r.status === 403
            ? "Site likely blocking serverless requests. We can switch to a headless-browser approach if needed."
            : "Non-200 status from source site.",
        sample: body.slice(0, 300),
      });
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    // Try multiple selectors, pick the one with the most matches
    let bestSelector = null;
    let best = [];
    for (const sel of CANDIDATE_CARD_SELECTORS) {
      const found = $(sel).toArray();
      if (found.length > best.length) {
        best = found;
        bestSelector = sel;
      }
    }

    // Fallback: any div that contains "Total Population"
    if (best.length === 0) {
      const allDivs = $("div").toArray();
      const candidates = allDivs.filter((el) =>
        $(el).text().toLowerCase().includes("total population")
      );
      best = candidates;
      bestSelector = "(heuristic div contains 'Total Population')";
    }

    const rows = [];
    for (const el of best) {
      const $el = $(el);
      const text = $el.text().replace(/\s+/g, " ").trim();
      if (!/total\s*population/i.test(text)) continue; // sanity check

      const { name, details } = extractNameAndDetails($el);
      const totalPop = extractTotal(text);
      const grades = extractGrades(text);
      const numberChunk =
        extractCardNumberChunk(text) || extractCardNumberChunk(details);

      if (!name && !details) continue;

      rows.push({
        name,
        details,
        cardNumber: numberChunk || null,
        totalPop,
        grades,
      });
    }

    // Optional filtering
    let filtered = rows;

    if (pokemonName) {
      const q = String(pokemonName).toLowerCase();
      filtered = filtered.filter(
        (r) =>
          (r.name && r.name.toLowerCase().includes(q)) ||
          (r.details && r.details.toLowerCase().includes(q))
      );
    }

    if (cardNumber) {
      const want = String(cardNumber).replace(/\s+/g, "");
      filtered = filtered.filter(
        (r) => r.cardNumber && r.cardNumber.replace(/\s+/g, "") === want
      );
    }

    const lim = limit ? Math.max(1, Math.min(200, Number(limit))) : null;
    const out = lim ? filtered.slice(0, lim) : filtered;

    return res.status(200).json({
      ok: true,
      source: url,
      selectorUsed: bestSelector,
      totalFound: rows.length,
      returned: out.length,
      filteredBy: {
        pokemonName: pokemonName || null,
        cardNumber: cardNumber || null,
      },
      cards: out,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
