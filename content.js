// ==========================================================================
// content.js
// Automation logic — รันบนหน้า labs.google/fx
// อัพเดทให้ตรงกับ DOM จริงของ Google Flow:
//   - ช่อง prompt เป็น Slate editor ([data-slate-editor="true"])
//   - ปุ่ม Generate มี class แบบ dynamic (sc-xxx) ต้องหาแบบ relative
//   - ใช้ MutationObserver รอภาพใหม่
//   - ดาวน์โหลดผ่าน chrome.downloads.download() (ส่งไป background worker)
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
    running: false,       // กำลังทำงานอยู่หรือไม่
    stopRequested: false, // มีการกด stop หรือยัง
    completed: 0,         // จำนวนภาพที่สร้างสำเร็จ
    total: 0              // จำนวนภาพที่ต้องการทั้งหมด
  };

  // ==========================================================================
  // Helper: ส่ง message กลับไปที่ popup สำหรับ log/status
  // ==========================================================================
  function sendLog(message, level = "info") {
    try {
      chrome.runtime.sendMessage({ type: "ZENITYX_LOG", message, level });
    } catch (e) {
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
  // Helper: sleep แบบ async + รองรับการ stop
  // ==========================================================================
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sleepWithStopCheck(ms) {
    const chunk = 200;
    const iterations = Math.ceil(ms / chunk);
    for (let i = 0; i < iterations; i++) {
      if (state.stopRequested) return;
      await sleep(Math.min(chunk, ms - i * chunk));
    }
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
  // findPromptBox — หา Slate editor ของ Google Flow
  // ใช้ polling รอจนกว่า DOM จะโหลดเสร็จ (สูงสุด 30 วินาที)
  // ==========================================================================
  async function findPromptBox(maxWait = 30000) {
    const interval = 500;
    let elapsed = 0;
    while (elapsed < maxWait) {
      // ลอง selector หลักก่อน แล้ว fallback ไปตัวกว้างขึ้น
      const selectors = [
        '[data-slate-editor="true"][contenteditable="true"]',
        '[data-slate-editor="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (isVisible(el)) {
            return el;
          }
        }
      }

      // ยังไม่เจอ — รอแล้วลองใหม่
      await new Promise((r) => setTimeout(r, interval));
      elapsed += interval;
    }
    // หมดเวลา — return null ให้ caller จัดการ error
    return null;
  }

  // ==========================================================================
  // fillPrompt — กรอก text ลงใน Slate editor
  // ใช้ Clipboard API เขียนลง clipboard จริง แล้วจำลอง Ctrl+V + paste event
  // fallback เป็น execCommand('insertText') ถ้ายังไม่ detect
  // ==========================================================================
  async function fillPrompt(text) {
    const editor = await findPromptBox();
    if (!editor) {
      throw new Error("ไม่พบช่อง prompt (Slate editor) บนหน้า Google Flow — รอ 30 วินาทีแล้วยังไม่เจอ");
    }

    // step 1: focus ที่ editor
    editor.focus();
    await sleep(500);

    // step 2: Select all + delete เคลียร์เนื้อหาเดิม
    const selectAll = new KeyboardEvent("keydown", {
      key: "a", code: "KeyA", ctrlKey: true,
      bubbles: true, cancelable: true
    });
    editor.dispatchEvent(selectAll);
    await sleep(200);

    const backspace = new KeyboardEvent("keydown", {
      key: "Backspace", code: "Backspace",
      bubbles: true, cancelable: true
    });
    editor.dispatchEvent(backspace);
    await sleep(300);

    // step 3: เขียนลง clipboard จริงผ่าน Clipboard API
    try {
      await navigator.clipboard.writeText(text);
      await sleep(200);
    } catch (err) {
      sendLog(`เขียน clipboard ล้มเหลว: ${err.message}`, "warning");
    }

    // step 4: จำลอง Ctrl+V keydown
    const pasteKeydown = new KeyboardEvent("keydown", {
      key: "v", code: "KeyV", ctrlKey: true,
      bubbles: true, cancelable: true
    });
    editor.dispatchEvent(pasteKeydown);
    await sleep(200);

    // step 5: ส่ง ClipboardEvent paste พร้อม data
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    });
    editor.dispatchEvent(pasteEvent);
    await sleep(500);

    // step 6: fallback — ถ้ายังไม่มีข้อความ ลอง execCommand
    if (!editor.textContent || editor.textContent.trim().length < 10) {
      sendLog("paste ไม่ทำงาน — ลอง execCommand fallback", "warning");
      editor.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, text);
      await sleep(300);
    }

    sendLog(`กรอก prompt สำเร็จ (${text.length} ตัวอักษร)`, "info");
  }

  // ==========================================================================
  // uploadProductImage — อัพโหลดรูปสินค้าก่อน generate
  // Google Flow บังคับให้อัพโหลดรูปก่อน generate ได้
  //
  // Flow จริง:
  // 1. กดปุ่ม "+" (aria-haspopup="dialog") ข้าง Slate editor
  // 2. รอ popup เปิด → กดปุ่ม "อัพโหลดรูปภาพ"
  // 3. หา input[type="file"] ที่ซ่อนอยู่ → ใส่ File object
  // 4. dispatch change event → รอรูปโหลด
  // ==========================================================================
  async function uploadProductImage() {
    // ดึง base64 จาก storage — ถ้าไม่มีรูปให้ข้ามไป
    const data = await chrome.storage.local.get("productImageBase64");
    const base64 = data.productImageBase64;
    if (!base64) {
      sendLog("ไม่มีรูปสินค้าใน storage — ข้ามขั้นตอนอัพโหลด", "info");
      return false;
    }

    sendLog("กำลังอัพโหลดรูปสินค้า...", "info");

    // แปลง base64 (data URL) เป็น File object
    const file = base64ToFile(base64, "product-image.png");

    // === step 1: กดปุ่ม "+" ข้าง prompt ===
    const plusBtn = findPlusButton();
    if (!plusBtn) {
      sendLog("ไม่พบปุ่ม '+' ข้าง prompt — ข้ามขั้นตอนอัพโหลด", "warning");
      return false;
    }
    sendLog("กดปุ่ม '+' เปิดเมนูอัพโหลด...", "info");
    plusBtn.click();
    await sleep(500);

    // === step 2: กดปุ่ม "อัพโหลดรูปภาพ" ใน popup ===
    const uploadOption = findUploadOption();
    if (!uploadOption) {
      sendLog("ไม่พบตัวเลือก 'อัพโหลดรูปภาพ' ใน popup — ลอง fallback", "warning");
      // fallback: หา input[type="file"] โดยตรง
      const directInput = findFileInput();
      if (directInput) {
        injectFileToInput(directInput, file);
        await sleep(2000);
        return true;
      }
      return false;
    }
    sendLog("กดตัวเลือก 'อัพโหลดรูปภาพ'...", "info");
    uploadOption.click();
    await sleep(500);

    // === step 3: หา input[type="file"] ที่ซ่อนอยู่แล้วใส่ไฟล์ ===
    const fileInput = await pollForFileInput(5000);
    if (!fileInput) {
      sendLog("ไม่พบ input[type='file'] หลังกดอัพโหลด", "error");
      return false;
    }
    injectFileToInput(fileInput, file);

    // === step 4: รอรูปโหลดขึ้นหน้า ===
    sendLog("รอรูปโหลด...", "info");
    await sleep(2000);
    sendLog("✓ อัพโหลดรูปสินค้าสำเร็จ", "success");
    return true;
  }

  // ใส่ File เข้า input[type="file"] ผ่าน DataTransfer แล้ว dispatch change
  function injectFileToInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // แปลง base64 data URL เป็น File object
  function base64ToFile(dataUrl, filename) {
    const [header, data] = dataUrl.split(",");
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i);
    }
    return new File([array], filename, { type: mime });
  }

  // หาปุ่ม "+" ข้าง prompt (มี aria-haspopup="dialog")
  function findPlusButton() {
    const editor = document.querySelector(
      '[data-slate-editor="true"][contenteditable="true"]'
    );

    // strategy 1: หา button[aria-haspopup="dialog"] ใกล้ editor
    if (editor) {
      let container = editor.parentElement;
      for (let depth = 0; depth < 6 && container; depth++) {
        const buttons = container.querySelectorAll(
          'button[type="button"][aria-haspopup="dialog"]'
        );
        for (const btn of buttons) {
          if (isVisible(btn)) return btn;
        }
        container = container.parentElement;
      }
    }

    // strategy 2: fallback — หาปุ่ม "+" ทั่วหน้า
    const allButtons = document.querySelectorAll('button[aria-haspopup="dialog"]');
    for (const btn of allButtons) {
      if (isVisible(btn)) return btn;
    }

    // strategy 3: หาปุ่มที่มีแต่ "+" หรือ svg icon ใกล้ editor
    if (editor) {
      let container = editor.parentElement;
      for (let depth = 0; depth < 4 && container; depth++) {
        const buttons = container.querySelectorAll("button");
        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const text = (btn.textContent || "").trim();
          if (text === "+" || text === "＋") return btn;
        }
        container = container.parentElement;
      }
    }

    return null;
  }

  // หาตัวเลือก "อัพโหลดรูปภาพ" ใน popup/dialog ที่เปิดขึ้นมา
  function findUploadOption() {
    // scan ทุก div หาตัวที่ textContent ตรงกับ "อัพโหลดรูปภาพ"
    const allDivs = document.querySelectorAll("div, span, li, a, button, [role='menuitem'], [role='option']");
    for (const el of allDivs) {
      const text = (el.textContent || "").trim();
      // เปรียบเทียบตรง ๆ ก่อน
      if (text === "อัพโหลดรูปภาพ") return el;
    }
    // fallback: หาตัวที่มี "อัพโหลด" อยู่ในข้อความ
    for (const el of allDivs) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (
        (text.includes("อัพโหลด") || text.includes("upload")) &&
        (text.includes("รูป") || text.includes("image") || text.includes("ภาพ") || text.includes("photo"))
      ) {
        // เลือก element ที่เล็กที่สุด (leaf-most) เพื่อไม่กดทั้ง container
        if (el.children.length === 0 || el.querySelector("svg")) return el;
      }
    }
    return null;
  }

  // หา input[type="file"] ที่มีอยู่ในหน้า
  function findFileInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const input of inputs) {
      const accept = (input.getAttribute("accept") || "").toLowerCase();
      if (!accept || accept.includes("image") || accept.includes("*")) {
        return input;
      }
    }
    return null;
  }

  // polling รอ input[type="file"] ปรากฏหลังคลิกปุ่ม upload
  async function pollForFileInput(maxWait = 5000) {
    const interval = 300;
    let elapsed = 0;
    while (elapsed < maxWait) {
      const found = findFileInput();
      if (found) return found;
      await sleep(interval);
      elapsed += interval;
    }
    return null;
  }

  // ==========================================================================
  // findGenerateButton — หาปุ่ม Generate ของ Google Flow
  // class เป็น dynamic (sc-xxx) จึงต้องใช้วิธี relative หลายแบบ
  // ==========================================================================
  async function findGenerateButton() {
    const promptBox = await findPromptBox();
    if (!promptBox) return null;

    // strategy 1: ไล่ขึ้นไปหา container แม่ แล้วหาปุ่มตัวสุดท้ายใน container
    // Google Flow มักวาง Generate เป็นปุ่มสุดท้ายใน prompt bar
    let container = promptBox.parentElement;
    for (let depth = 0; depth < 6 && container; depth++) {
      const buttons = container.querySelectorAll("button");
      if (buttons.length > 0) {
        // หาปุ่มที่ visible, ไม่ disabled, มี svg ข้างใน (icon button)
        const candidates = [];
        for (const btn of buttons) {
          if (btn.disabled || !isVisible(btn)) continue;
          // นับคะแนน: ปุ่มที่มี svg icon น่าจะเป็น Generate
          let score = 0;
          if (btn.querySelector("svg")) score += 2;
          // aria-label ที่ hint ว่าเป็น generate/submit
          const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
          if (
            ariaLabel.includes("generate") ||
            ariaLabel.includes("create") ||
            ariaLabel.includes("submit") ||
            ariaLabel.includes("send") ||
            ariaLabel.includes("run")
          ) {
            score += 5;
          }
          // text ภายในปุ่ม
          const text = (btn.textContent || "").trim().toLowerCase();
          if (
            text.includes("generate") ||
            text.includes("create") ||
            text.includes("สร้าง") ||
            text === ""  // icon-only button มักไม่มี text
          ) {
            score += 1;
          }
          // ปุ่มตัวสุดท้ายมักเป็น submit
          candidates.push({ btn, score });
        }

        if (candidates.length > 0) {
          // sort ตามคะแนน, ถ้าเท่ากันเอาตัวสุดท้ายใน DOM (มักเป็น submit)
          candidates.sort((a, b) => b.score - a.score);
          if (candidates[0].score > 0) {
            return candidates[0].btn;
          }
          // ถ้าคะแนนเป็น 0 ทั้งหมด — เอาปุ่มตัวสุดท้าย
          return candidates[candidates.length - 1].btn;
        }
      }
      container = container.parentElement;
    }

    // strategy 2: global scan — หาปุ่มที่อยู่ถัดจาก slate editor ใน DOM order
    const allButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => !b.disabled && isVisible(b)
    );

    // หาปุ่มที่อยู่ใกล้ promptBox มากที่สุด (วัดด้วยระยะ pixel)
    const pRect = promptBox.getBoundingClientRect();
    let nearest = null;
    let nearestDist = Infinity;

    for (const btn of allButtons) {
      // ข้ามปุ่มที่เป็นส่วนของ nav/header (อยู่ไกลจาก prompt)
      const bRect = btn.getBoundingClientRect();
      const dx = bRect.left - pRect.right;
      const dy = bRect.top - pRect.top;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // ต้องอยู่ในระยะ ~500px จาก prompt box
      if (dist < nearestDist && dist < 500) {
        nearestDist = dist;
        nearest = btn;
      }
    }

    return nearest;
  }

  // ==========================================================================
  // clickGenerate — คลิกปุ่ม Generate
  // ==========================================================================
  async function clickGenerate() {
    const btn = await findGenerateButton();
    if (!btn) {
      throw new Error("ไม่พบปุ่ม Generate บนหน้า");
    }

    // scroll เข้า viewport ก่อน (กัน click ไม่โดน)
    btn.scrollIntoView({ behavior: "instant", block: "nearest" });
    await sleep(100);

    // ยิง pointer events ครบชุดให้เหมือนคลิกจริง
    const rect = btn.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y };

    btn.dispatchEvent(new PointerEvent("pointerdown", eventOpts));
    btn.dispatchEvent(new MouseEvent("mousedown", eventOpts));
    btn.dispatchEvent(new PointerEvent("pointerup", eventOpts));
    btn.dispatchEvent(new MouseEvent("mouseup", eventOpts));
    btn.click();

    const label =
      btn.getAttribute("aria-label") ||
      (btn.textContent || "").trim() ||
      "(icon button)";
    sendLog(`คลิกปุ่ม Generate: ${label.substring(0, 40)}`, "info");
    return true;
  }

  // ==========================================================================
  // waitForResult — ใช้ MutationObserver รอให้ภาพใหม่ปรากฏ
  // timeout 120 วินาที
  // ==========================================================================
  function waitForResult(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      // snapshot ภาพที่มีอยู่ก่อนเริ่ม เพื่อเปรียบเทียบหาของใหม่
      const existingImages = new Set();
      document.querySelectorAll("img").forEach((img) => {
        if (img.src) existingImages.add(img.src);
      });

      sendLog(`snapshot: ${existingImages.size} ภาพที่มีอยู่ก่อนเริ่ม`, "info");

      // เช็คว่าภาพนี้น่าจะเป็นผลลัพธ์จริงหรือไม่
      const looksLikeResult = (img) => {
        const src = img.src;
        if (!src) return false;
        if (existingImages.has(src)) return false;

        // ต้องเป็น URL จริง
        if (
          !src.startsWith("blob:") &&
          !src.startsWith("data:image") &&
          !src.startsWith("https://")
        ) {
          return false;
        }

        // กรอง blacklist
        const lowerSrc = src.toLowerCase();
        if (
          lowerSrc.includes("avatar") ||
          lowerSrc.includes("favicon") ||
          lowerSrc.includes("logo") ||
          lowerSrc.includes("gstatic.com/images/branding")
        ) {
          return false;
        }

        // ต้องโหลดเสร็จแล้วและขนาดใหญ่พอ
        if (img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256) {
          return true;
        }
        return false;
      };

      const checkForNewImage = () => {
        if (state.stopRequested) {
          cleanup();
          reject(new Error("ผู้ใช้สั่งหยุด"));
          return;
        }

        const allImgs = document.querySelectorAll("img");
        for (const img of allImgs) {
          if (looksLikeResult(img)) {
            cleanup();
            resolve(img);
            return;
          }
        }

        if (Date.now() - startTime > timeoutMs) {
          cleanup();
          reject(new Error(`รอผลลัพธ์นานเกิน ${timeoutMs / 1000} วินาที`));
        }
      };

      // MutationObserver จับการเพิ่ม DOM node หรือเปลี่ยน src
      const observer = new MutationObserver(() => {
        checkForNewImage();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"]
      });

      // เสริมด้วย interval เผื่อ image load ช้ากว่า DOM mutation
      const intervalId = setInterval(checkForNewImage, 1500);

      function cleanup() {
        observer.disconnect();
        clearInterval(intervalId);
      }

      // เรียก check ครั้งแรกทันที
      checkForNewImage();
    });
  }

  // ==========================================================================
  // downloadResult — ดาวน์โหลดภาพ
  // วิธี 1: ส่ง URL ไปยัง background worker ให้ใช้ chrome.downloads.download()
  // วิธี 2 (fallback): fetch blob + anchor download ถ้า background ล้มเหลว
  // ==========================================================================
  async function downloadResult(imgElement, filename) {
    const src = imgElement.src;
    if (!src) {
      throw new Error("ภาพไม่มี src");
    }
    sendLog(`กำลังดาวน์โหลด: ${src.substring(0, 60)}...`, "info");

    // วิธี 1: ส่งให้ background worker ใช้ chrome.downloads.download()
    try {
      const response = await chrome.runtime.sendMessage({
        type: "ZENITYX_DOWNLOAD",
        url: src,
        filename: filename
      });

      if (response && response.ok) {
        sendLog(`✓ บันทึกไฟล์: ${filename} (id=${response.downloadId})`, "success");
        return true;
      }
      // ถ้า background แจ้ง error — log แล้วไป fallback
      sendLog(
        `background download ล้มเหลว: ${response?.error || "unknown"} — ลองวิธี blob`,
        "warning"
      );
    } catch (err) {
      sendLog(`ส่ง message ไป background ล้มเหลว: ${err.message}`, "warning");
    }

    // วิธี 2 (fallback): fetch blob แล้ว trigger <a download>
    try {
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      sendLog(`✓ บันทึกไฟล์ (fallback blob): ${filename}`, "success");
      return true;
    } catch (err) {
      sendLog(`ดาวน์โหลดล้มเหลวทุกวิธี: ${err.message}`, "error");
      return false;
    }
  }

  // ==========================================================================
  // generateOnce — ทำหนึ่งรอบ: fill → click → wait → download
  // มี retry logic สูงสุด 3 ครั้ง
  // ==========================================================================
  async function generateOnce(prompt, index, productName) {
    const MAX_RETRY = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      if (state.stopRequested) throw new Error("ผู้ใช้สั่งหยุด");

      try {
        sendLog(`รอบที่ ${index + 1} — ครั้งที่ ${attempt}/${MAX_RETRY}`, "accent");

        // step 1: อัพโหลดรูปสินค้า (ถ้ามี)
        sendStatus(`รอบ ${index + 1}: กำลังอัพโหลดรูปสินค้า...`);
        await uploadProductImage();

        if (state.stopRequested) throw new Error("ผู้ใช้สั่งหยุด");

        // step 2: กรอก prompt
        sendStatus(`รอบ ${index + 1}: กำลังกรอก prompt...`);
        await fillPrompt(prompt);
        await sleepWithStopCheck(500);

        if (state.stopRequested) throw new Error("ผู้ใช้สั่งหยุด");

        // step 3: คลิก Generate
        sendStatus(`รอบ ${index + 1}: กำลังคลิก Generate...`);
        await clickGenerate();

        // step 4: รอผลลัพธ์
        sendStatus(`รอบ ${index + 1}: กำลังรอภาพผลลัพธ์...`);
        const resultImg = await waitForResult(120000);

        if (state.stopRequested) throw new Error("ผู้ใช้สั่งหยุด");

        // step 5: ดาวน์โหลด
        sendStatus(`รอบ ${index + 1}: กำลังดาวน์โหลด...`);
        const timestamp = Date.now();
        const safeName = (productName || "product").replace(/[^a-zA-Z0-9ก-๙]/g, "_");
        const filename = `zenityx_${safeName}_${index + 1}_${timestamp}.png`;
        await downloadResult(resultImg, filename);

        return true;
      } catch (err) {
        lastError = err;
        sendLog(
          `ครั้งที่ ${attempt} ล้มเหลว: ${err.message}`,
          attempt === MAX_RETRY ? "error" : "warning"
        );

        if (state.stopRequested || err.message.includes("หยุด")) {
          throw err;
        }

        if (attempt < MAX_RETRY) {
          await sleepWithStopCheck(3000);
        }
      }
    }

    throw lastError || new Error("Generate ล้มเหลวทุกครั้ง");
  }

  // ==========================================================================
  // runQueue — วนทำงานตามจำนวนที่กำหนด
  // ==========================================================================
  async function runQueue(prompt, count, productName) {
    state.running = true;
    state.stopRequested = false;
    state.completed = 0;
    state.total = count;

    sendLog(`เริ่มคิว generate: ${count} รอบ`, "success");
    sendLog(
      `Prompt: ${prompt.substring(0, 80)}${prompt.length > 80 ? "..." : ""}`,
      "info"
    );

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
          if (state.stopRequested || err.message.includes("หยุด")) {
            sendStopped();
            return;
          }
        }

        // delay 5-10 วินาทีระหว่างแต่ละรอบ
        if (i < count - 1 && !state.stopRequested) {
          const delayMs = 5000 + Math.floor(Math.random() * 5000);
          sendLog(
            `รอ ${(delayMs / 1000).toFixed(1)} วินาที ก่อนรอบถัดไป...`,
            "info"
          );
          await sleepWithStopCheck(delayMs);
        }
      }

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
