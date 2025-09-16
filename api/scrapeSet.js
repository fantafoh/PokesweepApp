import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    // If cheerio is installed, this will exist:
    const version = (cheerio && (cheerio.version || "ok")) || "missing";
    return res.status(200).json({
      ok: true,
      cheerioVersion: version
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
