// ==========================================================================
// background.js
// Service worker สำหรับ MV3 — รับคำสั่งจาก content script เพื่อดาวน์โหลดภาพ
// เพราะ chrome.downloads.download() เรียกจาก content script โดยตรงไม่ได้
// ==========================================================================

// ฟังก์ชันช่วยดาวน์โหลดภาพ
// รองรับทั้ง https://, blob: และ data: URL
async function downloadImage(url, filename) {
  // blob: URL จะใช้ได้เฉพาะใน context ที่สร้างมัน (content script)
  // ดังนั้นถ้าเจอ blob: ให้ fallback เป็น fetch แล้วแปลงเป็น data URL
  if (url.startsWith("blob:")) {
    throw new Error("blob URL ต้องดาวน์โหลดจาก content script (fallback)");
  }

  // ส่งให้ chrome.downloads.download() จัดการ
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (downloadId === undefined) {
          reject(new Error("chrome.downloads.download() ไม่ return id"));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

// ==========================================================================
// Message listener — รับจาก content script (และ popup ถ้าต้องการ)
// ==========================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: "invalid message" });
    return false;
  }

  if (msg.type === "ZENITYX_DOWNLOAD") {
    const { url, filename } = msg;
    if (!url || !filename) {
      sendResponse({ ok: false, error: "missing url or filename" });
      return false;
    }

    downloadImage(url, filename)
      .then((downloadId) => {
        sendResponse({ ok: true, downloadId });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });

    // return true เพื่อให้ sendResponse async ทำงานได้
    return true;
  }

  // ไม่รู้จัก message type — ไม่ต้องตอบ
  return false;
});

console.log("[ZenityX] background service worker loaded");
