// api/scrapeSet.js
// Fetch a Pikawiz pop-report page by set slug (e.g., baseset, evolvingskies),
// parse each card block, and (optionally) filter by pokemonName and/or cardNumber.
// Returns PSA grade pops (10→1) plus name/details/totalPop.

import * as cheerio from "cheerio";

const CANDIDATE_CARD_SELECTORS = [
  ".card",                 // common guess
  ".card-box",
  ".card-item",
  "article",
  "li.card",
  "div[class*='card']",
  "div:has(h2):has(:contains('Total'))", // heuristic
];

function cleanNum(s) {
  if (!s) return null;
  const m = String(s).replace(/[^\d]/g, "");
  return m ? Number(m) : null;
}

function extractGrades(text) {
  // Find "PSA 10 1234", "PSA10 1,234", etc.
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
  // Grab things like "215/203" or "4/102"
  const m = /(\d{1,4}\s*\/\s*\d{1,4})/.exec(text);
  return m ? m[1].replace(/\s+/g, "") : null;
}

function extractNameAndDetails($el) {
  // Try several places for name and details
  const name =
    $el.find("h2").first().text().trim() ||
    $el.find("h3").first().text().trim() ||
    $el.find(".name").first().text().trim() ||
    "";

  // details often in a <p>, sometimes in small/subtitle
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
    const url = `https://www.pikawiz.com/cards/pop-report/${encodeURIComponent(
      setSlug.toLowerCase().replace(/\s+/g, "")
    )}`;

    // Fetch the set page
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) {
      return res.status(r.status).json({
        error: `Failed to fetch set page (${r.status})`,
        url,
      });
    }
    const html = await r.text();
    const $ = cheerio.load(html);

    // Find card blocks by trying multiple selectors; pick the selector with most hits.
    let bestSelector = null;
    let best = [];
    for (const sel of CANDIDATE_CARD_SELECTORS) {
      const found = $(sel).toArray();
      if (found.length > best.length) {
        best = found;
        bestSelector = sel;
      }
    }

    // Fallback: if we still found nothing, try a very loose heuristic: blocks containing "Total Population"
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
      const numberChunk = extractCardNumberChunk(text) || extractCardNumberChunk(details);

      // Skip obviously empty blocks
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

    // Optional limit to keep payload small
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
