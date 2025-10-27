// src/server.js
import express from "express";
import bodyParser from "body-parser";
import { runTask } from "./runTask.js";

const app = express();
app.use(bodyParser.json());

app.get("/health", (_req, res) => res.send("ok"));

app.post("/run", async (req, res) => {
  try {
    const result = await runTask(req.body || {});
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Run failed:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
