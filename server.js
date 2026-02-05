const express = require("express");
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "neuro-trading-public-template", ts: Date.now() });
});

// Public-safe webhook: validates shape, returns demo response only.
app.post("/webhook/tradingview", (req, res) => {
  const { symbol, action, price, quantity, webhook_secret } = req.body || {};
  if (!symbol || !action) {
    return res.status(400).json({ ok: false, error: "Missing symbol/action" });
  }

  // Template only: never validate real secrets here.
  if (webhook_secret && webhook_secret !== "YOUR_SECRET_HERE") {
    return res.status(401).json({ ok: false, error: "Unauthorized (template)" });
  }

  return res.json({
    ok: true,
    status: "accepted_demo",
    received: { symbol, action, price, quantity },
    note: "Public template only. No real trading executed."
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Listening on http://localhost:${PORT}`));

