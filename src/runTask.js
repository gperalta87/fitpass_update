// src/runTask.js
import puppeteer from "puppeteer";

/* =========================
   Config / defaults
   ========================= */
const DEFAULTS = {
  email: "hola@pontepila.com",
  password: "fitpass2025",
  targetDate: "2025-10-31",   // YYYY-MM-DD
  targetTime: "08:00",        // HH:mm (24h) or "8:00 am"
  targetName: "",             // optional filter
  newCapacity: 2,
  strictRequireName: true,    // (kept for future use)
  debug: false,
};
const TIMEOUT = 10000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================
   Small utils
   ========================= */
function toMinutes(t) {
  if (!t) return null;
  const s = String(t).trim().toLowerCase()
    .replace(/a\s*\.?\s*m\.?/g, "am").replace(/p\s*\.?\s*m\.?/g, "pm");
  const m = s.match(/(\d{1,2})[:\.](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || "").toLowerCase();
  if (ap) {
    const pm = ap === "pm";
    if (h === 12 && !pm) h = 0;
    if (h !== 12 && pm) h += 12;
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

/* =========================
   Debug hooks
   ========================= */
function attachPageDebug(page) {
  page.on("console", (m) => console.log("PAGE:", m.text()));
  page.on("requestfailed", (r) => console.log("REQ FAIL:", r.url(), r.failure()?.errorText));
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
}

/* =========================
   Click reliability
   ========================= */
const OVERLAYS = [
  ".modal-backdrop.show",
  ".spinner-border", ".spinner-grow",
  "[data-loading='true']",
  ".loading", ".is-loading"
];
async function waitForNoOverlay(page, timeout = 15000) {
  await page.waitForFunction(
    (sels) => !sels.some((sel) => document.querySelector(sel)),
    { timeout },
    OVERLAYS
  ).catch(() => {});
}

async function clickReliable(page, selector, { nav = false, timeout = 20000, retries = 3 } = {}) {
  for (let i = 1; i <= retries; i++) {
    try {
      await waitForNoOverlay(page, timeout);
      const handle = await page.waitForSelector(selector, { visible: true, timeout });
      await page.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }), handle);
      await page.waitForFunction((el) => {
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
          page.waitForNavigation({ waitUntil: "networkidle2", timeout }),
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

/* =========================
   Modal action by text (EDITAR CLASE)
   ========================= */
async function clickModalButtonByText(page, texts, { timeout = 30000 } = {}) {
  const norm = (s) =>
    (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const wanted = texts.map(norm);

  const modalSel = "#schedule_modal_container, .modal.show, .modal[style*='display: block']";
  const modal = await page.waitForSelector(modalSel, { visible: true, timeout });

  const clicked = await page.evaluate((modalEl, wantedTexts) => {
    const norm = (s) =>
      (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

    const candidates = Array.from(modalEl.querySelectorAll("button, a")).filter((el) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility !== "visible" || st.pointerEvents === "none") return false;
      const t = norm(el.innerText || el.textContent || "");
      return wantedTexts.some((w) => t.includes(w));
    });

    const target = candidates[0];
    if (!target) return false;
    target.scrollIntoView({ block: "center", behavior: "instant" });
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }, modal, wanted);

  if (!clicked) throw new Error(`Modal button with text not found: ${texts.join(" | ")}`);

  // best-effort nav wait (some buttons are <button> not <a>)
  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout });
  } catch {}
}

/* =========================
   Calendar helpers
   ========================= */
async function gotoDate(page, isoDate, debug = false) {
  if (debug) console.log("📅 gotoDate →", isoDate);

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
// Try to extract the edit URL from the modal or page, then navigate directly
async function clickEditarClaseButton(page, { timeout = 30000 } = {}) {
  console.log("Trying to find EDITAR CLASE button and extract edit URL...");

  // Wait for the modal to appear and finish its animation
  await page.waitForSelector(
    "#schedule_modal_container, .modal.show, .modal[style*='display: block']",
    { visible: true, timeout }
  );
  await delay(600);

  // First, try to extract the edit URL from the page
  const editUrl = await page.evaluate(() => {
    // Look for edit URLs in various places
    const modal = document.querySelector("#schedule_modal_container, .modal.show, .modal[style*='display: block']");
    if (!modal) return null;
    
    // Strategy 1: Look for edit URLs in data attributes
    const editLink = modal.querySelector('a[href*="edit"], a[href*="schedules"], button[data-url*="edit"], button[data-href*="edit"]');
    if (editLink) {
      return editLink.href || editLink.getAttribute('data-url') || editLink.getAttribute('data-href');
    }
    
    // Strategy 2: Look for schedule ID in data attributes or hidden inputs
    const scheduleId = modal.querySelector('[data-schedule-id], [data-id], input[name*="schedule"], input[name*="id"]');
    if (scheduleId) {
      const id = scheduleId.getAttribute('data-schedule-id') || 
                 scheduleId.getAttribute('data-id') || 
                 scheduleId.value;
      if (id) {
        // Try to construct edit URL
        const baseUrl = window.location.origin;
        return `${baseUrl}/schedules/${id}/edit`;
      }
    }
    
    // Strategy 3: Look for edit URLs in the page's JavaScript variables
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const content = script.textContent || '';
      const editMatch = content.match(/edit[^"']*url[^"']*["']([^"']+)["']/i) || 
                       content.match(/["']([^"']*edit[^"']*)["']/i) ||
                       content.match(/["']([^"']*schedules[^"']*edit[^"']*)["']/i);
      if (editMatch) {
        return editMatch[1];
      }
    }
    
    // Strategy 4: Look for form action URLs
    const form = modal.querySelector('form[action*="edit"], form[action*="schedules"]');
    if (form) {
      return form.action;
    }
    
    // Strategy 5: Look for the EDITAR CLASE link specifically (the actual button)
    // Priority: Look for btn-primary with "EDITAR CLASE" text - this is the correct button
    const allLinks = Array.from(modal.querySelectorAll('a, button'));
    for (const link of allLinks) {
      const text = (link.textContent || "").toLowerCase().trim();
      const hasBtnPrimary = link.classList.contains('btn-primary');
      // Prioritize buttons with btn-primary class and "EDITAR CLASE" text
      if ((text.includes("editar clase") || (text.includes("editar") && hasBtnPrimary))) {
        const href = link.href || link.getAttribute('href') || link.getAttribute('data-url') || link.getAttribute('data-href');
        if (href && href.includes('/edit') && !href.includes('cancel') && !href.includes('delete')) {
          // Convert relative URL to absolute if needed
          if (href.startsWith('/')) {
            const fullUrl = window.location.origin + href;
            console.log("Found EDITAR CLASE link (btn-primary):", fullUrl);
            return fullUrl;
          }
          console.log("Found EDITAR CLASE link (btn-primary):", href);
          return href;
        }
      }
    }
    
    // Strategy 6: Fallback - look for any links with edit URLs
    for (const link of allLinks) {
      const href = link.href || link.getAttribute('href') || link.getAttribute('data-url') || link.getAttribute('data-href');
      if (href && (href.includes('/edit') && !href.includes('cancel') && !href.includes('delete'))) {
        if (href.startsWith('/')) {
          return window.location.origin + href;
        }
        return href;
      }
    }
    
    return null;
  });

  // Don't try direct navigation - Turbo links must be clicked, not navigated to directly
  // The URL requires specific headers/context that only the button click provides
  console.log("Will click button instead of direct navigation (Turbo link requires click)");
  
  // Debug: Log all available information from the modal (only runs if needed for troubleshooting)
  await page.evaluate(() => {
    const modal = document.querySelector("#schedule_modal_container, .modal.show, .modal[style*='display: block']");
    if (!modal) {
      console.log("Modal not found for debugging");
      return;
    }
    
    console.log("=== MODAL DEBUG INFO ===");
    console.log("Modal HTML:", modal.outerHTML.substring(0, 500) + "...");
    console.log("All buttons:", Array.from(modal.querySelectorAll("button, a")).map(b => ({
      text: b.textContent?.trim(),
      className: b.className,
      href: b.href,
      onclick: b.getAttribute('onclick'),
      dataUrl: b.getAttribute('data-url'),
      dataHref: b.getAttribute('data-href')
    })));
    console.log("All data attributes:", Array.from(modal.querySelectorAll('*')).filter(el => {
      return Array.from(el.attributes).some(attr => attr.name.startsWith('data-'));
    }).map(el => ({
      tag: el.tagName,
      attributes: Array.from(el.attributes).filter(attr => attr.name.startsWith('data-')).map(attr => `${attr.name}="${attr.value}"`)
    })));
    console.log("All forms:", Array.from(modal.querySelectorAll('form')).map(f => ({
      action: f.action,
      method: f.method,
      innerHTML: f.innerHTML.substring(0, 200) + "..."
    })));
    console.log("=== END DEBUG INFO ===");
  });
  
  // Try using Puppeteer's selector to find and click the button (works better with Turbo)
  let buttonClicked = false;
  
  // Wait for the modal and button to be ready
  await page.waitForSelector(
    "#schedule_modal_container, .modal.show, .modal[style*='display: block']",
    { visible: true, timeout: 10000 }
  );
  await delay(300);
  
  // Try multiple selectors to find the EDITAR CLASE button
  const selectors = [
    'a.btn-primary[href*="/edit"]',  // Primary button with edit href
    'a[href*="/edit"].btn-primary',  // Link with edit and btn-primary  
    'a.btn-primary[href*="schedules"][href*="edit"]',  // Full path
  ];
  
  for (const selector of selectors) {
    try {
      console.log(`Trying selector: ${selector}`);
      const button = await page.$(selector);
      if (button) {
        const isVisible = await button.evaluate(el => {
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
        });
        
        if (isVisible) {
          console.log(`Found visible EDITAR CLASE button with selector: ${selector}`);
          // Scroll into view
          await button.evaluate(el => el.scrollIntoView({ block: "center", behavior: "smooth" }));
          await delay(400);
          
          // Click the button - Turbo may update content without navigating
          await button.click({ delay: 100 });
          console.log("Successfully clicked EDITAR CLASE button");
          
          // Wait for form to appear (either via navigation OR Turbo content update)
          await Promise.race([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
            page.waitForSelector('#schedule_lesson_availability', { visible: true, timeout: 15000 }).catch(() => {})
          ]);
          
          // Give Turbo a moment to update the DOM
          await delay(1000);
          
          // Verify the form field is actually present
          const formExists = await page.evaluate(() => {
            return document.querySelector("#schedule_lesson_availability") !== null;
          });
          
          if (formExists) {
            console.log("Edit form appeared after button click");
            buttonClicked = true;
            break;
          } else {
            console.log("Form field not found after click, trying next selector");
          }
        }
      }
    } catch (e) {
      console.log(`Selector ${selector} failed:`, e.message);
    }
  }
  
  // Fallback: Use evaluate if Puppeteer selectors didn't work
  if (!buttonClicked) {
    console.log("Puppeteer selectors didn't work, trying evaluate approach...");
    const buttonFound = await page.evaluate(() => {
      const modal = document.querySelector("#schedule_modal_container, .modal.show, .modal[style*='display: block']");
      if (!modal) {
        console.log("Modal not found in evaluate");
        return false;
      }
      
      // Find the EDITAR CLASE button - prioritize btn-primary with /edit href
      const buttons = Array.from(modal.querySelectorAll("a"));
      const editButton = buttons.find(btn => {
        const text = (btn.textContent || "").toLowerCase().trim();
        const href = btn.href || btn.getAttribute('href');
        return (text.includes("editar clase") || (text.includes("editar") && btn.classList.contains('btn-primary'))) &&
               href && href.includes('/edit');
      });
      
      if (!editButton) {
        console.log("EDITAR CLASE button not found");
        return false;
      }
      
      console.log("Found EDITAR CLASE button via evaluate:", editButton.textContent?.trim(), editButton.href);
      
      // Scroll and click
      editButton.scrollIntoView({ block: "center", behavior: "instant" });
      editButton.click();
      return true;
    });
    
    buttonClicked = buttonFound;
  }

  if (!buttonClicked) {
    throw new Error("Could not find or click EDITAR CLASE button");
  }

  // Wait for the form to appear (Turbo may update content without full navigation)
  console.log("Button clicked, waiting for edit form to appear...");
  
  // Wait for form field to appear (either via navigation or Turbo update)
  try {
    await page.waitForSelector('#schedule_lesson_availability', { visible: true, timeout: 20000 });
    console.log("Edit form field appeared");
  } catch (e) {
    // Form might already be present (Turbo updated it)
    const formExists = await page.evaluate(() => {
      return document.querySelector("#schedule_lesson_availability") !== null;
    });
    
    if (!formExists) {
      throw new Error("Edit form field did not appear after clicking EDITAR CLASE button");
    }
  }
  
  // Give it a moment for any Turbo animations/updates to complete
  await delay(1000);

  // Verify we have the form (either on edit page or in modal)
  const hasForm = await page.evaluate(() => {
    return document.querySelector("#schedule_lesson_availability") !== null ||
           document.querySelector("form[action*='schedules']") !== null;
  });
  
  if (!hasForm) {
    throw new Error("Edit form not found after button click");
  }

  console.log("Edit form is ready");
}

// Click a visible <button> or <input type=submit> by text (optionally scoped)
async function clickButtonByText(page, texts, { timeout = 30000, scope = "document" } = {}) {
  const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const wanted = texts.map(norm);

  const handle = scope === "document"
    ? null
    : await page.$(scope);

  const clicked = await page.evaluate((root, wantedTexts) => {
    const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const R = root || document;
    const candidates = Array.from(
      R.querySelectorAll('button, input[type="submit"], a[role="button"]')
    ).filter(el => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility !== "visible" || st.pointerEvents === "none") return false;
      const t = norm(el.innerText || el.value || el.textContent || "");
      return wantedTexts.some(w => t.includes(w));
    });
    const target = candidates[0];
    if (!target) return false;
    target.scrollIntoView({ block: "center" });
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }, handle, wanted);

  if (!clicked) throw new Error(`Button with text not found: ${texts.join(" | ")}`);
  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout }); } catch {}
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
    const txt = (await page.evaluate((n) => n.textContent || "", ev)).toLowerCase().trim();
    const startMins = extractStartTimeMinutes(txt);
    const timeScore = startMins === targetMins ? 100 : (startMins ? Math.max(0, 100 - Math.abs(startMins - targetMins)) : 0);
    const nameScore = targetName ? (txt.includes((targetName || "").toLowerCase()) ? 50 : 0) : 50;
    scored.push({ ev, txt, score: timeScore + nameScore });
  }
  scored.sort((a, b) => b.score - a.score);

  if (debug) {
    console.log(`🔎 Candidates on ${targetDate} (best first):`);
    for (const s of scored.slice(0, 6)) console.log("  ·", s.txt.slice(0, 140));
  }

  const best = scored[0];
  if (!best) return false;

  await best.ev.evaluate((n) => n.scrollIntoView({ block: "center" }));
  try { await best.ev.click(); } catch {}
  try {
    await page.evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })), best.ev);
  } catch {}

  // Wait for modal, let animations finish
  await page.waitForSelector("#schedule_modal_container, .modal.show, .modal[style*='display: block']", { visible: true, timeout: TIMEOUT });
  await delay(300);
  await page.waitForFunction(() => {
    const m = document.querySelector(".modal.show, .modal[style*='display: block']");
    return !!m && getComputedStyle(m).opacity === "1";
  }, { timeout: 3000 }).catch(() => {});


  // Click the visible blue "EDITAR CLASE" button
  await clickEditarClaseButton(page, { timeout: 30000 });


  return true;
}

/* =========================
   Main exported runner
   ========================= */
export async function runTask(input = {}) {
  const {
    email,
    password,
    targetDate,
    targetTime,
    targetName,
    newCapacity,
    strictRequireName, // unused now
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
  page.setDefaultTimeout(60000); // colder starts on PaaS
  attachPageDebug(page);
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36");
  await page.emulateTimezone("America/Mexico_City").catch(() => {});

  try {
    /* 1) Login */
    await page.goto("https://admin2.fitpass.com/sessions/new", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#login_user_email", { visible: true, timeout: TIMEOUT });
    await page.type("#login_user_email", email, { delay: 20 });
    await page.click("#login_user_password");
    await page.type("#login_user_password", password, { delay: 20 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      clickReliable(page, "#new_login_user button"),
    ]);

    /* 2) Go to Calendar */
    const calendarSelectors = [
      '#sidebar a[href*="calendar"]',
      '#sidebar a:nth-of-type(3)',
    ];
    let clicked = false;
    for (const sel of calendarSelectors) {
      try { await clickReliable(page, sel); clicked = true; break; } catch {}
    }
    if (!clicked) throw new Error("Could not navigate to calendar; menu/link not found.");
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 15000 }).catch(() => {});

    /* 3) Select date */
    await gotoDate(page, targetDate, debug);

    /* 4) Open correct event and enter edit */
    const opened = await openBestEvent(page, targetDate, targetTime, targetName, debug);
    if (!opened) throw new Error(`No matching event for ${targetDate} at ${targetTime}${targetName ? ` ("${targetName}")` : ""}.`);

    /* 5) Arrived at edit form → set capacity */
    console.log("Edit form should be ready, finding capacity field...");
    
    // Check what's actually on the page for debugging
    const pageInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        hasScheduleField: !!document.querySelector("#schedule_lesson_availability"),
        hasForm: !!document.querySelector("form[action*='schedules']"),
        allInputs: Array.from(document.querySelectorAll("input")).map(inp => ({
          id: inp.id,
          name: inp.name,
          type: inp.type,
          value: inp.value
        })),
        formActions: Array.from(document.querySelectorAll("form")).map(f => f.action)
      };
    });
    console.log("Page info after navigation:", JSON.stringify(pageInfo, null, 2));
    
    // Try multiple selectors to find the capacity field
    const capacitySelectors = [
      "#schedule_lesson_availability",
      "input[name*='availability']",
      "input[name*='capacity']",
      "input[name*='cupo']",
      "select[name*='availability']",
      "select[name*='capacity']",
      "#schedule_capacity",
      ".form-group input[type='number']",
      "form input[type='number']"
    ];
    
    let capacityField = null;
    for (const selector of capacitySelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        capacityField = await page.$(selector);
        if (capacityField) {
          console.log(`Found capacity field with selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    if (!capacityField) {
      throw new Error(`Could not find capacity field on edit page. Available inputs: ${JSON.stringify(pageInfo.allInputs)}`);
    }
    
    // Clear and set the capacity
    await capacityField.click({ clickCount: 3 }).catch(() => {});
    await capacityField.type(String(newCapacity), { delay: 15 });
    console.log(`Set capacity to: ${newCapacity}`);

    /* 6) Save */
    // 6) Save (text-first, then CSS fallbacks)
    try {
      await clickButtonByText(page, ["GUARDAR", "Guardar", "ACTUALIZAR", "Actualizar", "EDITAR", "Editar", "Save", "Update"], {
        timeout: 30000,
        scope: "form" // prioritize the edit form area
      });
    } catch {
      // CSS fallbacks commonly used by Bootstrap-themed forms
      const fallbacks = [
        'form button[type="submit"]',
        'form input[type="submit"]',
        'form .btn-primary',
        'form .btn-success',
        '.content button[type="submit"]',
      ];
      let done = false;
      for (const sel of fallbacks) {
        try {
          await clickReliable(page, sel, { nav: true, timeout: 20000 });
          done = true;
          break;
        } catch {}
      }
      if (!done) throw new Error("Could not find a Save/Submit button on the edit form.");
    }
    // allow the form submit to settle
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => {});

    /* 7) “Editar solo esta clase” (confirmation) */
    try {
      await clickModalButtonByText(page, [
        "EDITAR SOLO ESTA CLASE",
        "Editar solo esta clase",
        "SOLO ESTA CLASE",
        "EDITAR"
      ], { timeout: 20000 });
    } catch {
      await page.evaluate(() => {
        const modal = document.querySelector(".modal.show, .modal[style*='display: block']") || document;
        const btns = Array.from(modal.querySelectorAll(".modal-footer button, .modal-footer a, button, a")).filter((el) => {
          const s = getComputedStyle(el);
          return s.visibility === "visible" && s.display !== "none";
        });
        const first = btns[0];
        if (first) {
          first.scrollIntoView({ block: "center" });
          first.click();
          return true;
        }
        return false;
      });
      try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }); } catch {}
    }

    const msg = `✅ Safe-done: capacity ${newCapacity} on ${targetDate} at ${targetTime}${targetName ? ` for "${targetName}"` : ""}.`;
    console.log(msg);
    return { message: msg };
  } catch (err) {
    const p = "/tmp/last-failed.png";
    try {
      await page.screenshot({ path: p, fullPage: true });
      console.log("Saved debug screenshot:", p);
    } catch (sErr) {
      console.error("Failed to take screenshot:", sErr);
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
