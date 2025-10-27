// src/runTask.js
import puppeteer from "puppeteer";

/** ---------- Config & defaults ---------- */
const DEFAULTS = {
  email: "hola@pontepila.com",
  password: "fitpass2025",
  targetDate: "2025-10-28",  // YYYY-MM-DD
  targetTime: "08:00",       // HH:mm (24h) or "8:00 am"
  targetName: "",            // optional class name
  newCapacity: 4,
  strictRequireName: true,
  debug: false,
};
const TIMEOUT = 10000; // generic waits

/** ---------- Small utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function toMinutes(t) {
  if (!t) return null;
  const s = String(t).trim().toLowerCase()
    .replace(/a\s*\.?\s*m\.?/g, "am").replace(/p\s*\.?\s*m\.?/g, "pm");
  // accept "08:00", "8:00 am", "8.00am"
  const m = s.match(/(\d{1,2})[:\.](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || "").toLowerCase();
  if (ap) {
    const isPM = ap === "pm";
    if (h === 12 && !isPM) h = 0;
    if (h !== 12 && isPM) h += 12;
  }
  return h * 60 + min;
}
function extractStartTimeMinutes(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/a\s*\.?\s*m\.?/g, "am").replace(/p\s*\.?\s*m\.?/g, "pm");
  const m = s.match(/(\d{1,2})[:\.](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  const hh = m[1], mm = m[2], ap = m[3] || "";
  return toMinutes(`${hh}:${mm}${ap ? " " + ap : ""}`);
}

/** ---------- Debug hooks ---------- */
function attachPageDebug(page) {
  page.on("console", m => console.log("PAGE:", m.text()));
  page.on("requestfailed", r => console.log("REQ FAIL:", r.url(), r.failure()?.errorText));
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
}

/** ---------- Click reliability ---------- */
const OVERLAYS = [
  ".modal-backdrop.show",
  ".spinner-border", ".spinner-grow",
  "[data-loading='true']",
  ".loading", ".is-loading"
];
async function waitForNoOverlay(page, timeout = 15000) {
  await page.waitForFunction(
    sels => !sels.some(sel => document.querySelector(sel)),
    { timeout },
    OVERLAYS
  ).catch(() => {});
}

async function clickReliable(page, selector, { nav = false, timeout = 20000, retries = 3 } = {}) {
  for (let i = 1; i <= retries; i++) {
    try {
      await waitForNoOverlay(page, timeout);
      const handle = await page.waitForSelector(selector, { visible: true, timeout });
      await page.evaluate(el => el.scrollIntoView({ block: "center", inline: "center" }), handle);
      await page.waitForFunction(el => {
        if (!el || !el.isConnected) return false;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility !== "visible" || s.pointerEvents === "none") return false;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        return top && (top === el || el.contains(top)) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
      }, { timeout }, handle);

      if (nav) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle0", timeout }),
          handle.click({ delay: 20 }),
        ]);
      } else {
        await handle.click({ delay: 20 });
      }
      return; // success
    } catch (e) {
      if (i === retries) throw new Error(`Click failed for "${selector}": ${e.message}`);
      await delay(300 + i * 250);
    }
  }
}

/** ---------- Calendar helpers ---------- */

async function gotoDate(page, isoDate, debug = false) {
  if (debug) console.log("📅 gotoDate →", isoDate);

  // Try clickable date cells/headers first
  const tryOpen = async () => {
    const sels = [
      `td[data-date="${isoDate}"]`,
      `a[data-navlink="${isoDate}"]`,
      `.fc-col-header [data-date="${isoDate}"] a`,
      `.fc-daygrid-day[data-date="${isoDate}"] a`,
    ];
    for (const s of sels) {
      const el = await page.$(s);
      if (el) {
        if (debug) console.log("  Clicking date element:", s);
        await el.click().catch(() => {});
        await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
        return true;
      }
    }
    return false;
  };
  const clickBtn = async (selectors) => {
    for (const s of selectors) {
      const el = await page.$(s);
      if (el) {
        if (debug) console.log("  Nav button:", s);
        await el.click().catch(() => {});
        await page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
        return true;
      }
    }
    return false;
  };

  if (await tryOpen()) return true;

  for (let i = 0; i < 24; i++) {
    const moved = await clickBtn([
      ".fc-next-button", 'button[title="Next"]',
      'button[aria-label*="Next" i]', '#calendar .fc-toolbar .fc-next-button',
    ]);
    if (!moved) break;
    if (await tryOpen()) return true;
  }
  for (let i = 0; i < 24; i++) {
    const moved = await clickBtn([
      ".fc-prev-button", 'button[title="Prev"]',
      'button[aria-label*="Prev" i]', '#calendar .fc-toolbar .fc-prev-button',
    ]);
    if (!moved) break;
    if (await tryOpen()) return true;
  }

  throw new Error(`Could not navigate calendar to ${isoDate}.`);
}

async function openBestEvent(page, targetDate, targetTime, targetName = "", debug = false) {
  await page.waitForSelector(".fc-event, .fc-daygrid-event, .fc-timegrid-event, a.fc-event", {
    visible: true, timeout: TIMEOUT,
  });

  const targetMins = toMinutes(targetTime);
  const events = await page.$$(
    ".fc-timegrid-event, .fc-daygrid-event, .fc-event, a.fc-event, a.fc-daygrid-event"
  );

  const sameDate = async (el) => {
    return await page.evaluate((node, d) => {
      if (node.closest?.(`[data-date="${d}"]`)) return true;
      let n = node;
      while (n && n !== document.documentElement) {
        if (n.getAttribute) {
          const dd = n.getAttribute("data-date");
          if (dd === d) return true;
          const nav = n.getAttribute("data-navlink");
          if (nav === d) return true;
        }
        n = n.parentNode;
      }
      return false;
    }, el, targetDate);
  };

  const scored = [];
  for (const ev of events) {
    if (!(await sameDate(ev))) continue;
    const txt = (await page.evaluate(n => n.textContent || "", ev)).toLowerCase().trim();
    const startMins = extractStartTimeMinutes(txt);
    const timeScore = startMins === targetMins ? 100 : (startMins ? Math.max(0, 100 - Math.abs(startMins - targetMins)) : 0);
    const nameScore = targetName ? (txt.includes(targetName.toLowerCase()) ? 50 : 0) : 50;
    scored.push({ ev, txt, score: timeScore + nameScore });
  }
  scored.sort((a, b) => b.score - a.score);

  if (debug) {
    console.log(`🔎 Candidates on ${targetDate} (best first):`);
    for (const s of scored.slice(0, 6)) console.log("  ·", s.txt.slice(0, 120));
  }

  const best = scored[0];
  if (!best) return false;

  await best.ev.evaluate(n => n.scrollIntoView({ block: "center" }));
  // Try a normal click, then a dispatched click as backup
  try { await best.ev.click(); } catch {}
  try {
    await page.evaluate(el => {
      el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
    }, best.ev);
  } catch {}

  // Wait for modal
  await page.waitForSelector("#schedule_modal_container, .modal", { visible: true, timeout: TIMEOUT }).catch(() => {});
  await sleep(200);

  // Click the primary link/button inside the modal that navigates to edit form
  await clickModalPrimary(page, { timeout: 25000 });
  return true;
}

async function clickModalPrimary(page, { timeout = 20000 } = {}) {
  // Wait for any modal/root we know about
  const modalSel = "#schedule_modal_container, .modal.show, .modal[style*='display: block']";
  const modal = await page.waitForSelector(modalSel, { visible: true, timeout });

  // First, try common primary-action selectors
  const candidates = [
    // very specific first
    "#schedule_modal_container a.btn-primary",
    "#schedule_modal_container button.btn-primary",
    // general modal primaries
    ".modal.show a.btn-primary",
    ".modal.show button.btn-primary",
    ".modal .modal-footer .btn-primary",
    // sometimes it's just 'btn' not 'btn-primary'
    ".modal.show .modal-footer .btn",
    ".modal.show .btn.btn-primary",
  ];
  for (const sel of candidates) {
    const found = await page.$(sel);
    if (found) {
      await clickReliable(page, sel, { nav: true, timeout });
      return true;
    }
  }

  // Fallback: choose by text inside the modal (Editar / Edit / Ver / Detalles)
  const ok = await page.evaluate(() => {
    const root =
      document.querySelector("#schedule_modal_container") ||
      document.querySelector(".modal.show") ||
      document.querySelector(".modal[style*='display: block']");
    if (!root) return false;

    const isPrimary = (el) => {
      const c = (el.className || "").toLowerCase();
      return c.includes("btn-primary") || c.includes("btn");
    };

    const wantsText = (t) => {
      t = (t || "").toLowerCase();
      return (
        t.includes("editar") || t.includes("edit") ||
        t.includes("ver") || t.includes("detalle") ||
        t.includes("abrir")
      );
    };

    // Prefer buttons/links with "primary-ish" class and good text
    const els = Array.from(root.querySelectorAll("a, button"));
    const preferred = els.find((el) => isPrimary(el) && wantsText(el.textContent));
    const anyPrimary = preferred || els.find(isPrimary) || els[0];
    if (!anyPrimary) return false;

    anyPrimary.scrollIntoView({ block: "center", behavior: "instant" });
    anyPrimary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  });

  if (ok) {
    // If the JS click triggered nav, wait for it
    try {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout });
    } catch {}
    return true;
  }

  throw new Error("No primary action found in modal.");
}


/** ---------- Main exported runner ---------- */
export async function runTask(input = {}) {
  const {
    email,
    password,
    targetDate,
    targetTime,
    targetName,
    newCapacity,
    strictRequireName,
    debug,
  } = { ...DEFAULTS, ...input };

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  attachPageDebug(page);
  await page.emulateTimezone("Europe/Madrid").catch(() => {});

  try {
    /** 1) Login */
    await page.goto("https://admin2.fitpass.com/sessions/new", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#login_user_email", { visible: true, timeout: TIMEOUT });
    await page.type("#login_user_email", email, { delay: 20 });
    await page.click("#login_user_password");
    await page.type("#login_user_password", password, { delay: 20 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}),
      clickReliable(page, "#new_login_user button"),
    ]);

    /** 2) Go to Calendar */
    const calendarSelectors = [
      '#sidebar a[href*="calendar"]',
      '#sidebar a:nth-of-type(3)'
    ];
    let clicked = false;
    for (const sel of calendarSelectors) {
      try { await clickReliable(page, sel); clicked = true; break; } catch {}
    }
    if (!clicked) throw new Error("Could not navigate to calendar; menu/link not found.");
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 15000 }).catch(() => {});

    /** 3) Pick date */
    await gotoDate(page, targetDate, debug);

    /** 4) Open correct event (by time/name) */
    const opened = await openBestEvent(page, targetDate, targetTime, targetName, debug);
    if (!opened) throw new Error(`No matching event found for ${targetDate} at ${targetTime}${targetName ? ` ("${targetName}")` : ""}.`);

    /** 5) Set capacity */
    await page.waitForSelector("#schedule_lesson_availability", { visible: true, timeout: TIMEOUT });
    await page.click("#schedule_lesson_availability", { clickCount: 3 }).catch(() => {});
    await page.type("#schedule_lesson_availability", String(newCapacity), { delay: 15 });

    /** 6) Save */
    await clickReliable(page, 'footer button[type="submit"], footer > div:nth-of-type(1) button');
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});

    /** 7) “Editar solo esta clase” (first button in the confirmation area) */
    try {
      await clickReliable(page, "div.text-start button");
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
    } catch {
      throw new Error('Could not find or click "Editar solo esta clase" button.');
    }

    const msg = `✅ Safe-done: capacity ${newCapacity} on ${targetDate} at ${targetTime}${targetName ? ` for "${targetName}"` : ""}.`;
    console.log(msg);
    return { message: msg };
  } catch (err) {
    if (debug) {
      const p = `/tmp/failed-${Date.now()}.png`;
      await page.screenshot({ path: p, fullPage: true }).catch(() => {});
      console.log("Saved debug screenshot:", p);
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
