// ==========================================================================
// content.js
// Automation logic — รันบนหน้า labs.google/fx
// หน้าที่: หาช่อง prompt, กรอก prompt, กดปุ่ม generate, รอผลลัพธ์, ดาวน์โหลด
// ==========================================================================

(() => {
  // กัน inject ซ้ำถ้า content script ถูกโหลดมากกว่าหนึ่งครั้ง
  if (window.__ZENITYX_LOADED__) {
    console.log("[ZenityX] already loaded");
    return;
  }
  window.__ZENITYX_LOADED__ = true;

  // ---------- state ของ automation loop ----------
  const state = {
    running: false,      // กำลังทำงานอยู่หรือไม่
    stopRequested: false, // มีการกด stop หรือยัง
    completed: 0,        // จำนวนภาพที่สร้างสำเร็จ
    total: 0             // จำนวนภาพที่ต้องการทั้งหมด
  };

  // ==========================================================================
  // Helper: ส่ง message กลับไปที่ popup สำหรับ log/status
  // ==========================================================================
  function sendLog(message, level = "info") {
    try {
      chrome.runtime.sendMessage({ type: "ZENITYX_LOG", message, level });
    } catch (e) {
      // popup อาจปิดอยู่ — ไม่เป็นไร แค่ log ไว้ใน console
      console.log(`[ZenityX][${level}] ${message}`);
    }
  }

  function sendStatus(status, progress = null) {
    try {
      chrome.runtime.sendMessage({ type: "ZENITYX_STATUS", status, progress });
    } catch (e) {
      console.log(`[ZenityX][status] ${status}`);
    }
  }

  function sendDone(completed) {
    try {
      chrome.runtime.sendMessage({ type: "ZENITYX_DONE", completed });
    } catch (e) {}
  }

  function sendError(message) {
    try {
      chrome.runtime.sendMessage({ type: "ZENITYX_ERROR", message });
    } catch (e) {}
  }

  function sendStopped() {
    try {
      chrome.runtime.sendMessage({ type: "ZENITYX_STOPPED" });
    } catch (e) {}
  }

  // ==========================================================================
  // Helper: sleep แบบ async
  // ==========================================================================
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // รอด้วย interval เช็ค stop flag เพื่อให้หยุดได้ไวขึ้น
  async function sleepWithStopCheck(ms) {
    const chunk = 200;
    const iterations = Math.ceil(ms / chunk);
    for (let i = 0; i < iterations; i++) {
      if (state.stopRequested) return;
      await sleep(Math.min(chunk, ms - i * chunk));
    }
  }

  // ==========================================================================
  // findPromptBox — หาช่อง input สำหรับกรอก prompt
  // ใช้หลาย selector เพื่อความ stable หลีกเลี่ยง dynamic class names
  // ==========================================================================
  function findPromptBox() {
    // รายการ selector ที่น่าจะเจอช่อง prompt บน Google Flow
    // จัดลำดับจากเจาะจงที่สุดไปกว้างที่สุด
    const selectors = [
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="Prompt" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="Prompt" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="Describe" i]',
      'textarea[placeholder*="อธิบาย" i]',
      'textarea[data-testid*="prompt" i]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][data-testid*="prompt" i]',
      '[role="textbox"][aria-label*="prompt" i]',
      // fallback ล่าสุด: textarea ที่ visible ใน viewport
      'textarea',
      'div[contenteditable="true"]'
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        // ตรวจสอบว่า element visible จริง (มี size และไม่ถูกซ่อน)
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (
          rect.width > 100 &&
          rect.height > 20 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !el.disabled &&
          !el.readOnly
        ) {
          return el;
        }
      }
    }
    return null;
  }

  // ==========================================================================
  // fillPrompt — กรอก text ลงในช่อง prompt
  // ต้อง dispatch event หลายตัวเพื่อให้ React detect การเปลี่ยนแปลง
  // ==========================================================================
  async function fillPrompt(text) {
    const box = findPromptBox();
    if (!box) {
      throw new Error("ไม่พบช่อง prompt บนหน้า Google Flow");
    }

    // focus ก่อนเสมอเพื่อ simulate ผู้ใช้งานจริง
    box.focus();
    await sleep(100);

    if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
      // กรณี native input: ใช้ native setter เพื่อให้ React ตรวจจับได้
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;

      // เคลียร์ค่าเดิมก่อน
      if (nativeSetter) {
        nativeSetter.call(box, "");
      } else {
        box.value = "";
      }
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(50);

      // เขียนค่าใหม่
      if (nativeSetter) {
        nativeSetter.call(box, text);
      } else {
        box.value = text;
      }
    } else if (box.isContentEditable) {
      // กรณี contenteditable: set textContent + dispatch
      box.textContent = "";
      box.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await sleep(50);
      box.textContent = text;
    }

    // ยิง event หลายตัวเพื่อให้ framework ทุกตัวรับรู้การเปลี่ยนแปลง
    box.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    box.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    box.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a" })
    );
    box.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "a" })
    );

    await sleep(300);
    sendLog(`กรอก prompt สำเร็จ (${text.length} ตัวอักษร)`, "info");
  }

  // ==========================================================================
  // clickGenerate — หาปุ่ม Generate แล้วคลิก
  // ==========================================================================
  async function clickGenerate() {
    // รวบรวม selector ที่น่าจะเจอปุ่ม generate
    const buttonSelectors = [
      'button[aria-label*="generate" i]',
      'button[aria-label*="Generate" i]',
      'button[aria-label*="create" i]',
      'button[data-testid*="generate" i]',
      'button[data-testid*="submit" i]',
      'button[type="submit"]'
    ];

    // พยายามหาด้วย selector ตรง ๆ ก่อน
    for (const selector of buttonSelectors) {
      const buttons = document.querySelectorAll(selector);
      for (const btn of buttons) {
        if (!btn.disabled && isVisible(btn)) {
          btn.click();
          sendLog("คลิกปุ่ม Generate (selector match)", "info");
          return true;
        }
      }
    }

    // fallback: หา button ที่มี text ว่า generate/create/สร้าง
    const allButtons = document.querySelectorAll("button");
    for (const btn of allButtons) {
      const textContent = (btn.textContent || "").trim().toLowerCase();
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      const hay = `${textContent} ${ariaLabel}`;

      if (
        (hay.includes("generate") ||
          hay.includes("create") ||
          hay.includes("สร้าง")) &&
        !btn.disabled &&
        isVisible(btn)
      ) {
        btn.click();
        sendLog(`คลิกปุ่ม Generate (text match: "${textContent}")`, "info");
        return true;
      }
    }

    throw new Error("ไม่พบปุ่ม Generate บนหน้า");
  }

  // ตรวจสอบว่า element visible จริงหรือไม่
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  // ==========================================================================
  // waitForResult — ใช้ MutationObserver รอให้ภาพผลลัพธ์ปรากฏ
  // timeout 120 วินาที
  // ==========================================================================
  function waitForResult(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      // เก็บ URL ของภาพที่มีอยู่ก่อนเริ่ม เพื่อเปรียบเทียบหาภาพใหม่
      const existingImages = new Set(
        Array.from(document.querySelectorAll("img")).map((img) => img.src)
      );

      // ฟังก์ชันตรวจสอบว่าเจอภาพใหม่หรือยัง
      const checkForNewImage = () => {
        if (state.stopRequested) {
          observer.disconnect();
          clearInterval(intervalId);
          reject(new Error("ผู้ใช้สั่งหยุด"));
          return;
        }

        // หาทุก img บนหน้าที่ URL ใหม่และเข้าเงื่อนไขรูปผลลัพธ์
        const allImgs = document.querySelectorAll("img");
        for (const img of allImgs) {
          const src = img.src;
          if (!src || existingImages.has(src)) continue;

          // กรอง: ต้องเป็น blob/data/https และไม่ใช่ icon เล็ก ๆ
          if (
            (src.startsWith("blob:") ||
              src.startsWith("data:image") ||
              src.startsWith("https://")) &&
            img.naturalWidth > 256 &&
            img.naturalHeight > 256
          ) {
            // กรอง blacklist: avatar, icon, logo
            if (
              src.includes("avatar") ||
              src.includes("icon") ||
              src.includes("logo") ||
              src.includes("favicon")
            ) {
              continue;
            }
            observer.disconnect();
            clearInterval(intervalId);
            resolve(img);
            return;
          }
        }

        // เช็ค timeout
        if (Date.now() - startTime > timeoutMs) {
          observer.disconnect();
          clearInterval(intervalId);
          reject(new Error(`รอผลลัพธ์นานเกิน ${timeoutMs / 1000} วินาที`));
        }
      };

      // MutationObserver จับการเปลี่ยนแปลงของ DOM
      const observer = new MutationObserver(() => {
        checkForNewImage();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"]
      });

      // เสริมด้วย setInterval เผื่อ MutationObserver พลาด
      const intervalId = setInterval(checkForNewImage, 1000);

      // เรียก check ครั้งแรกทันที
      checkForNewImage();
    });
  }

  // ==========================================================================
  // downloadResult — ดาวน์โหลดภาพผลลัพธ์
  // ใช้ fetch + blob แล้วสร้าง <a> trigger download
  // ==========================================================================
  async function downloadResult(imgElement, filename) {
    try {
      const src = imgElement.src;
      sendLog(`กำลังดาวน์โหลด: ${src.substring(0, 60)}...`, "info");

      // fetch blob จาก URL
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();

      // สร้าง object URL แล้ว trigger download
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // cleanup object URL หลังจากดาวน์โหลด
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

      sendLog(`✓ บันทึกไฟล์: ${filename}`, "success");
      return true;
    } catch (err) {
      sendLog(`ดาวน์โหลดล้มเหลว: ${err.message}`, "warning");
      return false;
    }
  }

  // ==========================================================================
  // generateOnce — วงจรหนึ่งรอบ: กรอก prompt → click → wait → download
  // มี retry logic สูงสุด 3 ครั้ง
  // ==========================================================================
  async function generateOnce(prompt, index, productName) {
    const MAX_RETRY = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      if (state.stopRequested) throw new Error("ผู้ใช้สั่งหยุด");

      try {
        sendLog(`รอบที่ ${index + 1} — ลองครั้งที่ ${attempt}/${MAX_RETRY}`, "accent");

        // step 1: กรอก prompt
        sendStatus(`รอบ ${index + 1}: กำลังกรอก prompt...`);
        await fillPrompt(prompt);
        await sleepWithStopCheck(500);

        if (state.stopRequested) throw new Error("ผู้ใช้สั่งหยุด");

        // step 2: คลิก generate
        sendStatus(`รอบ ${index + 1}: กำลังคลิก Generate...`);
        await clickGenerate();

        // step 3: รอผลลัพธ์
        sendStatus(`รอบ ${index + 1}: กำลังรอภาพผลลัพธ์...`);
        const resultImg = await waitForResult(120000);

        if (state.stopRequested) throw new Error("ผู้ใช้สั่งหยุด");

        // step 4: ดาวน์โหลด
        sendStatus(`รอบ ${index + 1}: กำลังดาวน์โหลด...`);
        const timestamp = Date.now();
        const safeName = (productName || "product").replace(/[^a-zA-Z0-9ก-๙]/g, "_");
        const filename = `zenityx_${safeName}_${index + 1}_${timestamp}.png`;
        await downloadResult(resultImg, filename);

        // สำเร็จ! return จาก retry loop
        return true;
      } catch (err) {
        lastError = err;
        sendLog(
          `ครั้งที่ ${attempt} ล้มเหลว: ${err.message}`,
          attempt === MAX_RETRY ? "error" : "warning"
        );

        // ถ้าผู้ใช้สั่งหยุดไม่ต้อง retry
        if (state.stopRequested || err.message.includes("หยุด")) {
          throw err;
        }

        // รอก่อน retry
        if (attempt < MAX_RETRY) {
          await sleepWithStopCheck(3000);
        }
      }
    }

    // ถ้า retry หมดแล้วยังไม่ได้ — throw error สุดท้าย
    throw lastError || new Error("Generate ล้มเหลวทุกครั้ง");
  }

  // ==========================================================================
  // runQueue — loop หลักสร้างภาพตามจำนวนที่กำหนด
  // ==========================================================================
  async function runQueue(prompt, count, productName) {
    state.running = true;
    state.stopRequested = false;
    state.completed = 0;
    state.total = count;

    sendLog(`เริ่มคิว generate: ${count} รอบ`, "success");
    sendLog(`Prompt: ${prompt.substring(0, 80)}${prompt.length > 80 ? "..." : ""}`, "info");

    try {
      for (let i = 0; i < count; i++) {
        if (state.stopRequested) {
          sendLog("ได้รับคำสั่งหยุด — ยุติ queue", "warning");
          sendStopped();
          return;
        }

        const progress = (i / count) * 100;
        sendStatus(`กำลังสร้างภาพ ${i + 1}/${count}`, progress);

        try {
          await generateOnce(prompt, i, productName);
          state.completed++;
          sendLog(`✓ สำเร็จรอบที่ ${i + 1}/${count}`, "success");
        } catch (err) {
          sendLog(`✗ รอบที่ ${i + 1} ล้มเหลว: ${err.message}`, "error");
          // ถ้าเป็นการหยุดโดยผู้ใช้ให้ break ทันที
          if (state.stopRequested || err.message.includes("หยุด")) {
            sendStopped();
            return;
          }
          // ถ้าเป็น error อื่น ข้ามไปทำรอบถัดไป
        }

        // delay 5-10 วินาทีระหว่างแต่ละรอบ (ถ้าไม่ใช่รอบสุดท้าย)
        if (i < count - 1 && !state.stopRequested) {
          const delayMs = 5000 + Math.floor(Math.random() * 5000);
          sendLog(`รอ ${(delayMs / 1000).toFixed(1)} วินาที ก่อนรอบถัดไป...`, "info");
          await sleepWithStopCheck(delayMs);
        }
      }

      // เสร็จทุกรอบ
      sendStatus("เสร็จสิ้น", 100);
      sendDone(state.completed);
    } catch (err) {
      sendError(err.message);
    } finally {
      state.running = false;
      state.stopRequested = false;
    }
  }

  // ==========================================================================
  // Message listener — รับคำสั่งจาก popup
  // ==========================================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) {
      sendResponse({ ok: false, error: "invalid message" });
      return;
    }

    switch (msg.type) {
      case "ZENITYX_START": {
        if (state.running) {
          sendResponse({ ok: false, error: "กำลังทำงานอยู่แล้ว" });
          return true;
        }
        const { prompt, count, productName } = msg.payload || {};
        if (!prompt) {
          sendResponse({ ok: false, error: "ไม่มี prompt" });
          return true;
        }
        // เริ่มงานแบบ async — ไม่ block message channel
        runQueue(prompt, count || 1, productName || "product").catch((err) => {
          sendError(err.message);
        });
        sendResponse({ ok: true });
        return true;
      }

      case "ZENITYX_STOP": {
        state.stopRequested = true;
        sendLog("ได้รับคำสั่งหยุดจากผู้ใช้", "warning");
        sendResponse({ ok: true });
        return true;
      }

      case "ZENITYX_PING": {
        sendResponse({ ok: true, loaded: true });
        return true;
      }

      default:
        sendResponse({ ok: false, error: "unknown message type" });
        return true;
    }
  });

  console.log("[ZenityX] content script loaded on", window.location.href);
})();
