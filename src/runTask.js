// src/runTask.js
import puppeteer from "puppeteer";

/** ========= DEFAULTS (used if request doesn't send values) ========= **/
const DEFAULTS = {
  EMAIL: "hola@pontepila.com",
  PASSWORD: "fitpass2025",
  TARGET_DATE: "2025-10-28",   // YYYY-MM-DD
  TARGET_TIME: "08:00",        // strict START time
  TARGET_NAME: "",             // optional class name or ""
  NEW_CAPACITY: 4,             // integer
  STRICT_REQUIRE_NAME: true,   // require TARGET_NAME in modal & form
  DEBUG: false
};
/** ================================================================== **/

const TIMEOUT = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(...args);

export async function runTask(body = {}) {
  const EMAIL = body.email ?? DEFAULTS.EMAIL;
  const PASSWORD = body.password ?? DEFAULTS.PASSWORD;
  const TARGET_DATE = body.targetDate ?? DEFAULTS.TARGET_DATE;
  const TARGET_TIME = body.targetTime ?? DEFAULTS.TARGET_TIME;
  const TARGET_NAME = body.targetName ?? DEFAULTS.TARGET_NAME;
  const NEW_CAPACITY = Number.isFinite(+body.newCapacity) ? +body.newCapacity : DEFAULTS.NEW_CAPACITY;
  const STRICT_REQUIRE_NAME = body.strictRequireName ?? DEFAULTS.STRICT_REQUIRE_NAME;
  const DEBUG = body.debug ?? DEFAULTS.DEBUG;
  

  const dlog = (...args) => DEBUG && console.log(...args);

  function toMinutes(t) {
    const m = String(t).match(/^\s*(\d{1,2})[:\.](\d{2})\s*(am|pm|a\.?m\.?|p\.?m\.?)?\s*$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const apRaw = m[3]?.toLowerCase();
    if (apRaw) {
      const isPM = /p/.test(apRaw.replace(/\s|\./g, ""));
      if (h === 12 && !isPM) h = 0;
      if (h !== 12 && isPM) h += 12;
    }
    return h * 60 + min;
  }

  function normalizeTimeTokens(txt) {
    return String(txt).toLowerCase()
      .replace(/a\s*\.?\s*m\.?/gi, "am")
      .replace(/p\s*\.?\s*m\.?/gi, "pm");
  }

  function extractStartTimeMinutes(txt) {
    const norm = normalizeTimeTokens(txt);
    const m = norm.match(/(\d{1,2})[:\.](\d{2})\s*(am|pm)?/i);
    if (!m) return null;
    const hh = m[1], mm = m[2], ap = m[3] || "";
    return toMinutes(`${hh}:${mm}${ap ? " " + ap : ""}`);
  }

  async function gotoDate(page, isoDate) {
    dlog("📅 gotoDate →", isoDate);

    const dateInputs = [
      'input[type="date"]', 'input[name="date"]',
      'input[aria-label*="fecha" i]', 'input[placeholder*="fecha" i]',
    ];
    for (const sel of dateInputs) {
      const exists = await page.$(sel);
      if (exists) {
        dlog("  Using date input:", sel);
        await page.evaluate((selector, value) => {
          const inp = document.querySelector(selector);
          if (!inp) return;
          inp.value = value;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        }, sel, isoDate);
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
        return true;
      }
    }

    const tryOpen = async () => {
      const sels = [
        `td[data-date="${isoDate}"]`,
        `a[data-navlink="${isoDate}"]`,
        `th[data-date="${isoDate}"] a`,
        `.fc-col-header [data-date="${isoDate}"] a`,
      ];
      for (const s of sels) {
        const el = await page.$(s);
        if (el) {
          dlog("  Clicking date element:", s);
          await el.click();
          await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
          return true;
        }
      }
      return false;
    };

    const clickBtn = async (selectors) => {
      for (const s of selectors) {
        const btn = await page.$(s);
        if (btn) {
          dlog("  Nav button:", s);
          await btn.click();
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

  async function closeModalIfOpen(page) {
    const safeCloseSelectors = [
      '#schedule_modal_container button.close',
      '#schedule_modal_container [data-bs-dismiss="modal"]',
      '.modal [data-bs-dismiss="modal"]',
      '.modal .btn-close',
    ];
    for (const sel of safeCloseSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = (await page.evaluate(el => el.textContent || '', el)).toLowerCase().trim();
        if (text.includes('cancelar clase') || text.includes('eliminar') || text.includes('borrar') ||
            text.includes('delete') || text.includes('remove')) {
          dlog("  Skipping potentially destructive button:", text);
          continue;
        }
        dlog("  Closing modal via safe selector:", sel);
        await el.click();
        await page.waitForNetworkIdle({ idleTime: 200, timeout: 4000 }).catch(() => {});
        return;
      }
    }
    dlog("  Closing modal via Escape (safe method)");
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
  }

  async function modalMatchesTarget(page) {
    await page.waitForSelector("#schedule_modal_container, .modal", { visible: true, timeout: TIMEOUT });
    await sleep(500);
    const raw = await page.evaluate(() => {
      const n = document.querySelector("#schedule_modal_container") || document.querySelector(".modal");
      return (n?.innerText || "");
    });
    const txt = normalizeTimeTokens(raw);
    const startMins = extractStartTimeMinutes(txt);
    const targetMins = toMinutes(TARGET_TIME);
    const timeOK = (startMins === targetMins);
    const nameOK = TARGET_NAME ? txt.toLowerCase().includes(TARGET_NAME.toLowerCase()) : true;

    const isCreateModal = !txt.includes("hora de la clase") && !txt.includes("fecha de inicio") &&
                         (txt.includes("disciplina") || txt.includes("cupo fitpass"));

    if (isCreateModal) {
      dlog("  [Modal check] Detected create new class modal - skipping");
      return false;
    }
    return (STRICT_REQUIRE_NAME ? (timeOK && nameOK) : (timeOK && nameOK));
  }

  async function formMatchesTarget(page) {
    const selectorCandidates = [
      '[id^="schedule_form_"]', 'form[action*="schedules"]',
      '#schedule_modal_container form', '.modal form', 'form',
    ];
    let raw = "";
    for (const sel of selectorCandidates) {
      const el = await page.$(sel);
      if (el) {
        raw = await page.evaluate((node) => node.innerText || "", el);
        if (raw) break;
      }
    }
    const txt = normalizeTimeTokens(raw);
    const startMins = extractStartTimeMinutes(txt);
    const targetMins = toMinutes(TARGET_TIME);
    const timeOK = (startMins === targetMins);
    const nameOK = TARGET_NAME ? txt.toLowerCase().includes(TARGET_NAME.toLowerCase()) : true;

    const pageTxt = normalizeTimeTokens(await page.evaluate(() => document.body.innerText || ""));
    const dateOK = pageTxt.includes(TARGET_DATE);

    dlog("  [Form check] timeOK:", timeOK, "| nameOK:", nameOK, "| dateOK:", dateOK);
    return (STRICT_REQUIRE_NAME ? (timeOK && nameOK) : (timeOK && nameOK)) && dateOK;
  }

  async function openCorrectEvent(page) {
    dlog("  [Event Discovery] Starting to look for events...");
    await page.waitForSelector(".fc-event, .fc-daygrid-event, .fc-timegrid-event", {
      visible: true, timeout: TIMEOUT,
    });
    dlog("  [Event Discovery] Found events, proceeding...");

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
      }, el, TARGET_DATE);
    };

    const targetMins = toMinutes(TARGET_TIME);
    const dateEvents = [];
    for (const ev of events) {
      if (!(await sameDate(ev))) continue;
      const txt = (await page.evaluate((n) => n.textContent || "", ev)).toLowerCase();
      dateEvents.push({ ev, preview: txt.trim().replace(/\s+/g, " ").slice(0, 160) });
    }

    if (DEBUG) {
      console.log(`🔎 Candidates on ${TARGET_DATE} (best first):`);
    }

    const scoredEvents = dateEvents.map(({ ev, preview }) => {
      const txt = preview.toLowerCase();
      const startMins = extractStartTimeMinutes(txt);
      const timeScore = startMins === targetMins ? 100 : (startMins ? Math.max(0, 100 - Math.abs(startMins - targetMins)) : 0);
      const nameScore = TARGET_NAME ? (txt.includes(TARGET_NAME.toLowerCase()) ? 50 : 0) : 50;
      const totalScore = timeScore + nameScore;
      return { ev, preview, score: totalScore, startMins };
    });

    scoredEvents.sort((a, b) => b.score - a.score);

    const bestEvent = scoredEvents[0];
    if (!bestEvent) {
      log("⚠️ No events found to score.");
      return false;
    }

    await bestEvent.ev.evaluate((n) => n.scrollIntoView({ block: "center", behavior: "instant" }));

    // Try both click paths
    try { await bestEvent.ev.click(); } catch {}
    try {
      await page.evaluate((element) => {
        element.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
      }, bestEvent.ev);
    } catch {}

    await sleep(100);

    const okModal = await modalMatchesTarget(page);
    if (!okModal) {
      dlog("  ✖ Modal mismatch — closing and trying next.");
      await closeModalIfOpen(page);
      await sleep(200);
      return false;
    }

    await page.waitForSelector("#schedule_modal_container a.btn-primary, .modal a.btn-primary", {
      visible: true, timeout: TIMEOUT,
    });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {}),
      page.click("#schedule_modal_container a.btn-primary, .modal a.btn-primary"),
    ]);

    return true;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);
  await page.emulateTimezone("Europe/Madrid").catch(() => {});

  try {
    // 1) Login
    await page.goto("https://admin2.fitpass.com/sessions/new", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#login_user_email", { visible: true });
    await page.type("#login_user_email", EMAIL, { delay: 25 });
    await page.click("#login_user_password");
    await page.type("#login_user_password", PASSWORD, { delay: 25 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }),
      page.click("#new_login_user button"),
    ]);

    // 2) Calendar
    try {
      await page.waitForSelector('#sidebar a[href*="calendar"]', { timeout: 3000 });
      await page.click('#sidebar a[href*="calendar"]');
    } catch {
      await page.click("#sidebar a:nth-of-type(3)");
    }
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});

    // 3) Date
    await gotoDate(page, TARGET_DATE);

    // 4) Open correct event
    const opened = await openCorrectEvent(page);
    if (!opened) throw new Error(`Aborting: no matching event for ${TARGET_DATE} at "${TARGET_TIME}"${TARGET_NAME ? ` with "${TARGET_NAME}"` : ""}.`);

    // 5) Set capacity
    await page.waitForSelector("#schedule_lesson_availability", { visible: true, timeout: TIMEOUT });
    await page.click("#schedule_lesson_availability", { clickCount: 3 });
    await page.type("#schedule_lesson_availability", String(NEW_CAPACITY), { delay: 20 });

    // 6) Save
    await page.waitForSelector('footer button[type="submit"], footer > div:nth-of-type(1) button', {
      visible: true, timeout: TIMEOUT,
    });
    await Promise.all([
      page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {}),
      page.click('footer button[type="submit"], footer > div:nth-of-type(1) button'),
    ]);

    // 7) “Editar solo esta clase”
    const buttons = await page.$$("div.text-start button");
    if (buttons.length) {
      await Promise.all([
        page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {}),
        buttons[0].click(),
      ]);
    } else {
      throw new Error('Could not find "EDITAR SOLO ESTA CLASE" button.');
    }

    const msg = `✅ Safe-done: capacity ${NEW_CAPACITY} on ${TARGET_DATE} at ${TARGET_TIME}${TARGET_NAME ? ` for "${TARGET_NAME}"` : ""}.`;
    console.log(msg);
    return { message: msg };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
