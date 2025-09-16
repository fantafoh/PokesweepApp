// api/scrapeSet.js
// Headless-browser scraper that loads Pikawiz set page like a real user,
// then parses card blocks with Cheerio. Works around 403/anti-bot pages.

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import * as cheerio from "cheerio";

// Allow up to ~25s to load (adjustable)
export const config = {
  maxDuration: 25
};

const CANDIDATE_CARD_SELECTORS = [
  ".card",
  ".card-box",
  ".card-item",
  "article",
  "li.card",
  "div[class*='card']"
];

function cleanNum(s) {
  if (!s) return null;
  const m = String(s).replace(/[^\d]/g, "");
  return m ? Number(m) : null;
}

function extractGrades(text) {
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
  const m = /Total\s*Population\s*([0-9,]+)/i.exec(text);
  return m ? cleanNum(m[1]) : null;
}

function extractCardNumberChunk(text) {
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
    return res.status(400).json({ error: "Provide ?setSlug=baseset (or evolvingskies, etc.)" });
  }

  const slug = String(setSlug).toLowerCase().replace(/\s+/g, "");
  const url = `https://www.pikawiz.com/cards/pop-report/${encodeURIComponent(slug)}`;

  let browser;
  try {
    // Launch serverless Chromium (works on Vercel)
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();

    // Spoof a normal desktop browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Referer": "https://www.pikawiz.com/cards/pop-report"
    });

    // Go to the page and wait for network to settle
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Small human-like pause (helps with some anti-bot)
    await page.waitForTimeout(1200);

    // If Cloudflare interstitial appears, wait a bit longer for redirect
    // (title often "Just a moment...")
    const title = await page.title();
    if (/just a moment/i.test(title)) {
      await page.waitForTimeout(4000);
    }

    // Grab the rendered HTML
    const html = await page.content();
    const $ = cheerio.load(html);

    // Try multiple selectors, pick the richest one
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
      if (!/total\s*population/i.test(text)) continue;

      const { name, details } = extractNameAndDetails($el);
      const totalPop = extractTotal(text);
      const grades = extractGrades(text);
      const numberChunk = extractCardNumberChunk(text) || extractCardNumberChunk(details);
      if (!name && !details) continue;

      rows.push({
        name,
        details,
        cardNumber: numberChunk || null,
        totalPop,
        grades
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
      filteredBy: { pokemonName: pokemonName || null, cardNumber: cardNumber || null },
      cards: out
    });
  } catch (err) {
    return res.status(500).json({ error: String(err), hint: "Headless scrape failed" });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}
