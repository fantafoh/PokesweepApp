// api/scrapeSet.js
// Headless-browser scraper that loads a Pikawiz set page like a real user,
// then parses card blocks by TEXT HEURISTICS (no brittle CSS).
// Works on Vercel (Node 22) with puppeteer-core + @sparticuz/chromium.

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

function extractGrades(text) {
  // Finds "PSA 10 13,782" or "PSA10 13782" (multiple times)
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
  // Accepts "Total Population 18,361" OR "Population 18,361"
  const m = /(Total\s*)?Population\s*([0-9,]+)/i.exec(text);
  return m ? cleanNum(m[2]) : null;
}

function extractCardNumberChunk(text) {
  // Grabs things like "215/203" or "4/102"
  const m = /(\d{1,4}\s*\/\s*\d{1,4})/.exec(text);
  return m ? m[1].replace(/\s+/g, "") : null;
}

function extractNameAndDetails($el) {
  // Try to get a visible name and some detail text from common elements
  const name =
    $el.find("h2, h3, .name, .title").first().text().trim() ||
    ""; // fallbacks handled by text heuristics

  // detail line often includes rarity + "x/xxx"
  const details =
    $el.find("p, .details, small, .subtitle, .sub").first().text().trim() || "";

  return { name, details };
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
    // Launch serverless Chromium (Vercel compatible)
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

    // Spoof a normal desktop browser
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

    // Navigate + light waits to get through interstitials
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(1200);

    try {
      const t1 = await page.title();
      if (/just a moment/i.test(t1)) {
        await sleep(4000);
      }
    } catch {}

    // Wait until the page has content that looks like PSA or card numbers
    try {
      await page.waitForFunction(
        () =>
          typeof document !== "undefined" &&
          document.body &&
          /PSA\s*\d|(\d{1,4}\s*\/\s*\d{1,4})/i.test(document.body.innerText),
        { timeout: 15000 }
      );
    } catch {
      // still try to parse
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    // Broad sweep: consider any section/article/div as a potential "card box"
    const candidates = $("section, article, div").toArray();

    const blocks = [];
    for (const el of candidates) {
      const $el = $(el);
      const text = $el.text().replace(/\s+/g, " ").trim();

      // Keep blocks that look like a card entry:
      // - must contain at least one PSA grade OR a card number like "x/xxx"
      if (!/(PSA\s*\d)|(\d{1,4}\s*\/\s*\d{1,4})/i.test(text)) continue;

      const grades = extractGrades(text);
      // If there are zero grades and no total pop and no number, it's probably noise
      const totalPop = extractTotal(text);
      const numChunk = extractCardNumberChunk(text);

      // Try to pluck a name/details if present
      const { name, details } = extractNameAndDetails($el);

      // Heuristic to reduce noise: require at least grades or a number chunk
      if (Object.keys(grades).length === 0 && !numChunk) continue;

      blocks.push({
        name,
        details,
        cardNumber: numChunk || null,
        totalPop,
        grades,
        _len: text.length // for debugging ordering (longer blocks are likelier to be real)
      });
    }

    // De-duplicate obvious repeats by (name + number)
    const seen = new Set();
    const rows = [];
    for (const b of blocks) {
      const key = `${(b.name || "").toLowerCase()}|${b.cardNumber || ""}`;
      if (seen.has(key) && key !== "|") continue;
      seen.add(key);
      rows.push(b);
    }

    // Optional filtering by user query
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

    // Sort longer/more detailed blocks first (tends to be higher-quality matches)
    filtered.sort((a, b) => (b._len || 0) - (a._len || 0));

    // Respect limit
    const lim = limit ? Math.max(1, Math.min(200, Number(limit))) : null;
    const out = lim ? filtered.slice(0, lim) : filtered;

    const resp = {
      ok: true,
      source: url,
      totalFound: rows.length,
      returned: out.length,
      filteredBy: { pokemonName: pokemonName || null, cardNumber: cardNumber || null },
      cards: out.map(({ _len, ...rest }) => rest)
    };

    if (debug) {
      // small debug signals to help tune parsers without dumping full HTML
      resp.debug = {
        nodeCount: candidates.length,
        blockCount: blocks.length,
        sampleTextHints: [
          $("body").text().slice(0, 200).replace(/\s+/g, " "),
          $("body").text().slice(200, 400).replace(/\s+/g, " ")
        ]
      };
    }

    return res.status(200).json(resp);
  } catch (err) {
    return res.status(500).json({ error: String(err), hint: "Headless scrape failed" });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}
