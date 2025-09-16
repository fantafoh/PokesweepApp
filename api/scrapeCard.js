export default function handler(req, res) {
  const { cardName } = req.query;

  if (!cardName) {
    return res.status(400).json({ error: "Please provide a cardName" });
  }

  // For now, just echo the card name
  res.status(200).json({ cardName });
}
