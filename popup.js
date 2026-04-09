// ==========================================================================
// popup.js
// Logic ฝั่ง popup — จัดการ UI, บันทึก state, ส่งคำสั่งไปหา content script
// ==========================================================================

// ---------- DOM reference ----------
const els = {
  uploadArea: document.getElementById("uploadArea"),
  productImage: document.getElementById("productImage"),
  uploadPlaceholder: document.getElementById("uploadPlaceholder"),
  previewImage: document.getElementById("previewImage"),
  removeImage: document.getElementById("removeImage"),
  productName: document.getElementById("productName"),
  styleSelect: document.getElementById("styleSelect"),
  customPrompt: document.getElementById("customPrompt"),
  imageCount: document.getElementById("imageCount"),
  countValue: document.getElementById("countValue"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),
  logContainer: document.getElementById("logContainer"),
  clearLog: document.getElementById("clearLog")
};

// ---------- state เก็บใน memory ของ popup ----------
let isRunning = false;

// ==========================================================================
// ฟังก์ชันจัดการ log — แสดงบน UI และ auto scroll
// ==========================================================================
function addLog(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString("th-TH", { hour12: false });
  const item = document.createElement("div");
  item.className = `log-item log-${type}`;
  item.textContent = `[${timestamp}] ${message}`;
  els.logContainer.appendChild(item);
  // จำกัดจำนวน log ไว้ไม่เกิน 200 entries เพื่อประหยัด memory
  while (els.logContainer.children.length > 200) {
    els.logContainer.removeChild(els.logContainer.firstChild);
  }
  els.logContainer.scrollTop = els.logContainer.scrollHeight;
}

// อัพเดทสถานะ + progress bar
function updateStatus(text, progressPercent = null) {
  els.statusText.textContent = text;
  if (progressPercent !== null) {
    els.progressBar.style.width = `${Math.min(100, Math.max(0, progressPercent))}%`;
  }
}

// ==========================================================================
// โหลด state จาก chrome.storage เมื่อเปิด popup
// ==========================================================================
async function loadSavedState() {
  try {
    const data = await chrome.storage.local.get([
      "productName",
      "styleId",
      "customPrompt",
      "imageCount",
      "productImageBase64"
    ]);

    if (data.productName) els.productName.value = data.productName;
    if (data.styleId) els.styleSelect.value = data.styleId;
    if (data.customPrompt) els.customPrompt.value = data.customPrompt;
    if (data.imageCount) {
      els.imageCount.value = data.imageCount;
      els.countValue.textContent = data.imageCount;
    }
    if (data.productImageBase64) {
      showPreview(data.productImageBase64);
    }
  } catch (err) {
    addLog(`โหลด state ไม่สำเร็จ: ${err.message}`, "error");
  }
}

// บันทึก state ปัจจุบันลง chrome.storage.local
async function saveState() {
  try {
    await chrome.storage.local.set({
      productName: els.productName.value,
      styleId: els.styleSelect.value,
      customPrompt: els.customPrompt.value,
      imageCount: els.imageCount.value
    });
  } catch (err) {
    console.error("saveState error:", err);
  }
}

// ==========================================================================
// จัดการรูปสินค้า — อ่านเป็น base64 แล้วเก็บใน storage
// ==========================================================================
function showPreview(base64) {
  els.previewImage.src = base64;
  els.previewImage.classList.remove("hidden");
  els.removeImage.classList.remove("hidden");
  els.uploadPlaceholder.classList.add("hidden");
}

function clearPreview() {
  els.previewImage.src = "";
  els.previewImage.classList.add("hidden");
  els.removeImage.classList.add("hidden");
  els.uploadPlaceholder.classList.remove("hidden");
  els.productImage.value = "";
}

// แปลงไฟล์เป็น base64 ด้วย FileReader แบบ async
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

// Event: คลิก upload area เพื่อเปิด file picker
els.uploadArea.addEventListener("click", (e) => {
  if (e.target === els.removeImage) return;
  els.productImage.click();
});

// Event: เลือกไฟล์ → แปลงและเก็บ
els.productImage.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // จำกัดขนาดไฟล์ไม่เกิน 5MB กันใช้ storage เกิน
  if (file.size > 5 * 1024 * 1024) {
    addLog("รูปต้องมีขนาดไม่เกิน 5MB", "error");
    return;
  }

  try {
    const base64 = await fileToBase64(file);
    await chrome.storage.local.set({ productImageBase64: base64 });
    showPreview(base64);
    addLog(`อัพโหลดรูปสำเร็จ: ${file.name}`, "success");
  } catch (err) {
    addLog(`อัพโหลดรูปล้มเหลว: ${err.message}`, "error");
  }
});

// Event: ลบรูป
els.removeImage.addEventListener("click", async (e) => {
  e.stopPropagation();
  await chrome.storage.local.remove("productImageBase64");
  clearPreview();
  addLog("ลบรูปสินค้าแล้ว", "info");
});

// ==========================================================================
// Event listeners สำหรับ input ต่าง ๆ
// ==========================================================================

// อัพเดทค่า range slider แบบ realtime
els.imageCount.addEventListener("input", () => {
  els.countValue.textContent = els.imageCount.value;
  saveState();
});

// บันทึก state อัตโนมัติเมื่อเปลี่ยนค่า
[els.productName, els.styleSelect, els.customPrompt].forEach((el) => {
  el.addEventListener("change", saveState);
  el.addEventListener("input", saveState);
});

// เคลียร์ log
els.clearLog.addEventListener("click", () => {
  els.logContainer.innerHTML = "";
  addLog("เคลียร์ log แล้ว", "info");
});

// ==========================================================================
// ปุ่ม "เริ่มสร้างอัตโนมัติ"
// ==========================================================================
els.startBtn.addEventListener("click", async () => {
  // validate input
  const productName = els.productName.value.trim();
  const customPrompt = els.customPrompt.value.trim();
  const styleId = els.styleSelect.value;
  const count = parseInt(els.imageCount.value, 10);

  if (!productName && !customPrompt) {
    addLog("กรุณากรอกชื่อสินค้า หรือ custom prompt", "error");
    return;
  }

  // ถ้ามี custom prompt ใช้แทน template, ถ้าไม่ใช้ template ของ style ที่เลือก
  let finalPrompt;
  if (customPrompt) {
    finalPrompt = customPrompt.replace(/\{\{PRODUCT\}\}/g, productName || "the product");
    addLog("ใช้ Custom Prompt", "accent");
  } else {
    finalPrompt = window.buildPrompt(styleId, productName);
    addLog(`ใช้ preset: ${window.PROMPT_TEMPLATES[styleId].label}`, "accent");
  }

  // ตรวจสอบว่า tab ปัจจุบันเป็นหน้า Google Flow
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("labs.google/fx")) {
    addLog("กรุณาเปิดหน้า labs.google/fx ก่อนเริ่ม", "error");
    updateStatus("ไม่พบหน้า Google Flow");
    return;
  }

  // ตั้ง state เป็นกำลังทำงาน
  isRunning = true;
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
  updateStatus("กำลังเริ่มต้น...", 0);
  addLog(`เริ่มงาน — สร้าง ${count} ภาพ`, "success");

  try {
    // ส่งคำสั่ง START ไปยัง content script
    await chrome.tabs.sendMessage(tab.id, {
      type: "ZENITYX_START",
      payload: {
        prompt: finalPrompt,
        count: count,
        productName: productName,
        styleId: styleId
      }
    });
  } catch (err) {
    // ถ้า content script ยังไม่ถูก inject — แจ้ง error
    addLog(`ส่งคำสั่งไม่สำเร็จ: ${err.message}`, "error");
    addLog("ลอง reload หน้า labs.google/fx แล้วเปิด popup ใหม่", "warning");
    resetRunningState();
  }
});

// ==========================================================================
// ปุ่ม "หยุด"
// ==========================================================================
els.stopBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, { type: "ZENITYX_STOP" });
    }
    addLog("ส่งคำสั่งหยุด...", "warning");
  } catch (err) {
    addLog(`หยุดงานไม่สำเร็จ: ${err.message}`, "error");
  } finally {
    resetRunningState();
  }
});

// รีเซ็ต UI กลับสู่สถานะ idle
function resetRunningState() {
  isRunning = false;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
}

// ==========================================================================
// รับ message จาก content script — log, status, progress
// ==========================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "ZENITYX_LOG":
      addLog(msg.message, msg.level || "info");
      break;

    case "ZENITYX_STATUS":
      updateStatus(msg.status, msg.progress);
      break;

    case "ZENITYX_DONE":
      addLog(`✓ งานเสร็จสมบูรณ์ — สร้างภาพไปแล้ว ${msg.completed || 0} ภาพ`, "success");
      updateStatus("เสร็จสิ้น", 100);
      resetRunningState();
      break;

    case "ZENITYX_ERROR":
      addLog(`❌ ${msg.message}`, "error");
      updateStatus("เกิดข้อผิดพลาด");
      resetRunningState();
      break;

    case "ZENITYX_STOPPED":
      addLog("หยุดงานแล้วโดยผู้ใช้", "warning");
      updateStatus("หยุดแล้ว");
      resetRunningState();
      break;
  }

  // ส่ง response กลับเพื่อปิด port (ป้องกัน warning)
  sendResponse({ ok: true });
  return true;
});

// ==========================================================================
// Init เมื่อ DOM โหลดเสร็จ
// ==========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  await loadSavedState();
  addLog("ZenityX Auto Gen พร้อมใช้งาน", "accent");
});
