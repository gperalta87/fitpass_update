import express from "express";
import bodyParser from "body-parser";
import { runTask } from "./runTask.js";
import fs from "fs";
import path from "path";

const app = express();
app.use(bodyParser.json({ limit: "200kb" })); // small but safe
app.set("x-powered-by", false);

const PORT = process.env.PORT || 3000;

// simple root + health
app.get("/", (_req, res) => res.json({ status: "ok", message: "Fitpass Capacity Updater API" }));
app.get("/health", (_req, res) => res.send("ok"));

// in-memory mutex to avoid overlapping Puppeteer sessions
let running = false;

app.post("/run", async (req, res) => {
  const startedAt = new Date().toISOString();
  console.log(`[/run] start ${startedAt}`);

  if (running) {
    console.warn("[/run] rejected: job already running");
    return res.status(429).json({ ok: false, error: "A run is already in progress. Try again shortly." });
  }
  running = true;

  // hard guard so Railway proxy never sees us hang forever
  const GUARD_MS = Number(process.env.REQUEST_GUARD_MS || 120_000); // 60s
  const guard = setTimeout(() => console.error("[/run] guard timeout hit"), GUARD_MS);

  try {
    const { runTask } = await import("./runTask.js");
    const result = await runTask(req.body || {});
    clearTimeout(guard);
    console.log(`[/run] end ok ${new Date().toISOString()}`);
    return res.json({ ok: true, result });
  } catch (e) {
    clearTimeout(guard);
    console.error("[/run] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    running = false;
  }
});

app.get("/debug/last-screenshot", (req, res) => {
  const p = "/tmp/last-failed.png";
  if (!fs.existsSync(p)) {
    return res.status(404).send("No screenshot found yet");
  }
  res.sendFile(path.resolve(p));
});

app.get("/debug/before-save", (req, res) => {
  const p = "/tmp/before-save.png";
  if (!fs.existsSync(p)) {
    return res.status(404).send("No before-save screenshot found yet");
  }
  res.sendFile(path.resolve(p));
});

app.get("/debug/after-save", (req, res) => {
  const p = "/tmp/after-save.png";
  if (!fs.existsSync(p)) {
    return res.status(404).send("No after-save screenshot found yet");
  }
  res.sendFile(path.resolve(p));
});

app.get("/debug/after-editar-click", (req, res) => {
  const p = "/tmp/after-editar-click.png";
  if (!fs.existsSync(p)) {
    return res.status(404).send("No after-editar-click screenshot found yet");
  }
  res.sendFile(path.resolve(p));
});

app.get("/debug/form-not-found", (req, res) => {
  const p = "/tmp/form-not-found.png";
  if (!fs.existsSync(p)) {
    return res.status(404).send("No form-not-found screenshot found yet");
  }
  res.sendFile(path.resolve(p));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] Listening on 0.0.0.0:${PORT} (${new Date().toISOString()})`);
});

// Graceful shutdown (Railway sends SIGTERM on redeploy/idle scale-down)
process.on("SIGTERM", () => {
  console.log("[signal] SIGTERM received — shutting down");
  process.exit(0);
});
