// src/server.js
import express from "express";
import bodyParser from "body-parser";
import { runTask } from "./runTask.js";

const app = express();
app.use(bodyParser.json());

// Root endpoint
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Fitpass Capacity Updater API" });
});

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

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

// Handle process errors
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Keep process alive
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});