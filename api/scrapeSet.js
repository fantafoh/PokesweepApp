// api/scrapeSet.js
// Headless-browser scraper for Pikawiz pop report pages using Puppeteer-Core + @sparticuz/chromium.
// Tight heuristics: keep only blocks with a card number (e.g. 4/102) AND 3+ distinct PSA grade lines.
// Works on Node 22 on Vercel.

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import * as cheerio from "cheerio";

export const config = { maxDuration: 25 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanNum(s) {
  if (!s) return null;
  const m = String(s).replace(/[^\d]/g, "");
  return m ? Number(m) : null;
}

function findGrades(text) {
  // capture multiple "PSA 10 13,782" / "PSA10 13782"
  const out = [];
  const rx = /PSA\s*([0-9]{1,2})\s*([0-9,]+)/gi;
  let m;
  while ((m = rx.exec(text))) out.push({ grade: m[1], value: cleanNum(m[2]) });
  return out;
}

function extractGradesMap(text) {
  const grades = {};
  for (const g of findGrades(text)) {
    if (g.value != null) grades[`PSA ${g.grade}`] = g.value;
  }
  return grades;
}

function extractTotal(text) {
  // "Total Population 18,361" OR "Population 18,361"
  const m = /(Total\s*)?Population\s*([0-9,]+)/i.exec(text);
  return m ? cleanNum(m[2]) : null;
}

function extractCardNumber(text) {
  // "215/203", "4/102"
  const m = /(\d{1,4}\s*\/\s*\d{1,4})/.exec(text);
  return m ? m[1].replace(/\s+/g, "") : null;
}

function extractNameAndDetails($el) {
  const name =
    $el.find("h2, h3, .name, .title").first().text().trim() || "";
  const details =
    $el.find("p, .details, small, .subtitle, .sub").first().text().trim() || "";
  return { name, details };
}

// Fallback name guess: take the words preceding the first "x/xxx" number chunk
function fallbackNameFromText(text) {
  // capture up to ~60 chars before the number
  const m = /([A-Za-z0-9'’\- :]{2,60})\s+\d{1,4}\s*\/\s*\d{1,4}/.exec(text);
  if (!m) return "";
  // trim off obvious labels like "Pop Report"
  const guess = m[1].replace(/\b(Pop(ulation)?\s*Report)\b/i, "").trim();
  return guess;
}

export default async function handler(req, res) {
  const { setSlug, pokemonName, cardNumber, limit, debug } = req.query;

  if (!setSlug) {
    return res.status(400).json({ error: "Provide ?setSlug=baseset (or evolvingskies, etc.)" });
  }

  const slug = String(setSlug).toLowerCase().replace(/\s+/g, "");
  const url = `https://www.pikawiz.com/cards/pop-report/${encodeURIComponent(slug)}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: "https://www.pikawiz.com/cards/pop-report",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await sleep(1400);

    // If Cloudflare interstitial appears, give it a moment
    try {
      const t1 = await page.title();
      if (/just a moment/i.test(t1)) await sleep(4500);
    } catch {}

    // Wait for content hint: PSA grades or card number pattern somewhere
    try {
      await page.waitForFunction(
        () =>
          typeof document !== "undefined" &&
          document.body &&
          (/PSA\s*\d/i.test(document.body.innerText) ||
           /\d{1,4}\s*\/\s*\d{1,4}/.test(document.body.innerText)),
        { timeout: 15000 }
      );
    } catch {}

    const html = await page.content();
    const $ = cheerio.load(html);

    // Consider blocks: we’ll scan a manageable subset of elements
    // Use only elements likely to be "cards" (reduce noise)
    const candidates = $("article, section, li, div").toArray();

    const kept = [];
    for (const el of candidates) {
      const $el = $(el);
      const raw = $el.text().replace(/\s+/g, " ").trim();
      if (!raw) continue;

      const num = extractCardNumber(raw);
      if (!num) continue; // must have x/xxx

      const gradeList = findGrades(raw);
      const distinctGrades = new Set(gradeList.map(g => g.grade)).size;
      if (distinctGrades < 3) continue; // require at least 3 unique PSA grades inside the same block

      // Looks like a real card block; extract fields
      let { name, details } = extractNameAndDetails($el);
      if (!name) {
        const guess = fallbackNameFromText(raw);
        if (guess) name = guess;
      }

      const grades = extractGradesMap(raw);
      const totalPop = extractTotal(raw);

      // sanity: avoid obvious noise blocks
      if (Object.keys(grades).length === 0) continue;

      kept.push({
        name,
        details,
        cardNumber: num,
        totalPop,
        grades,
        _len: raw.length
      });
    }

    // De-duplicate by (name|cardNumber)
    const seen = new Set();
    const rows = [];
    for (const b of kept) {
      const key = `${(b.name || "").toLowerCase()}|${b.cardNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(b);
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
      filtered = filtered.filter((r) => r.cardNumber === want);
    }

    // Prefer richer blocks (longer text usually)
    filtered.sort((a, b) => (b._len || 0) - (a._len || 0));

    const lim = limit ? Math.max(1, Math.min(200, Number(limit))) : null;
    const out = lim ? filtered.slice(0, lim) : filtered;

    const response = {
      ok: true,
      source: url,
      totalFound: rows.length,
      returned: out.length,
      filteredBy: { pokemonName: pokemonName || null, cardNumber: cardNumber || null },
      cards: out.map(({ _len, ...rest }) => rest)
    };

    if (debug) {
      response.debug = {
        candidatesScanned: candidates.length,
        keptBlocks: kept.length
      };
    }

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({ error: String(err), hint: "Headless scrape failed" });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}
