// ==========================================================================
// prompt-templates.js
// รวม template prompt ภาษาอังกฤษสำหรับสไตล์ต่าง ๆ ของภาพสินค้า
// ใช้ {{PRODUCT}} เป็น placeholder ที่จะถูกแทนด้วยชื่อสินค้า/keyword
// ==========================================================================

// อ็อบเจ็กต์เก็บ template ทั้งหมด — key คือรหัสสไตล์, value คือรายละเอียด
const PROMPT_TEMPLATES = {
  // สไตล์โปรโมชั่นสุด — เน้นความปังแบบ TikTok Shop
  ultimate_promo: {
    id: "ultimate_promo",
    label: "โปรโมชั่นสุด (Ultimate Promo)",
    template:
      "Photorealistic Thai woman character enthusiastically holding {{PRODUCT}}, " +
      "vibrant promotional style, TikTok shop aesthetic, bold colorful Thai text overlay, " +
      "eye-catching background with dynamic lighting, explosive sale badges, " +
      "product showcase at center, commercial photography, ultra sharp details, " +
      "high saturation colors, 4K hyperrealistic, advertising campaign quality"
  },

  // สไตล์ UGC แบบอินฟลูเอนเซอร์รีวิว (มีข้อความกำกับ)
  ugc_review: {
    id: "ugc_review",
    label: "UGC: อินฟลูฯ รีวิว (มีข้อความ)",
    template:
      "Realistic selfie-style photo of a young Thai influencer reviewing {{PRODUCT}}, " +
      "pointing at the product with excited expression, casual home setting, " +
      "authentic UGC style, soft natural lighting, smartphone camera quality, " +
      "Thai text caption overlay explaining product benefits, genuine product review aesthetic, " +
      "TikTok vertical format, engaging facial expression, vlog style composition"
  },

  // สไตล์ UGC แบบใช้งานจริง — เน้นความ natural, ไม่มีข้อความ
  ugc_real: {
    id: "ugc_real",
    label: "UGC: เรียล/ใช้งานจริง (คลีน)",
    template:
      "Candid realistic photo of a Thai person naturally using {{PRODUCT}} in everyday life, " +
      "clean minimal composition, no text overlays, authentic lifestyle moment, " +
      "warm natural daylight, shallow depth of field, shot on smartphone aesthetic, " +
      "genuine unposed expression, cozy home or outdoor environment, " +
      "soft colors, documentary style photography, real user experience"
  },

  // ภาพสตูดิโอระดับพรีเมียม — เน้นความหรูหราของสินค้า
  studio_premium: {
    id: "studio_premium",
    label: "ภาพสตูดิโอ (Premium)",
    template:
      "Premium studio product photography of {{PRODUCT}}, professional lighting setup, " +
      "clean gradient background, dramatic rim lighting, ultra sharp focus, " +
      "luxury commercial style, reflective surface, floating presentation, " +
      "color-graded cinematic look, hyperdetailed textures, high-end advertising shot, " +
      "minimalist composition, magazine quality, 8K resolution"
  },

  // บรรยากาศไลฟ์สด — เหมือนกำลังขายของบน TikTok Live
  live_stream: {
    id: "live_stream",
    label: "บรรยากาศไลฟ์สด (Live)",
    template:
      "Thai live stream seller energetically presenting {{PRODUCT}} on camera, " +
      "TikTok Live broadcasting setup, ring light reflection in eyes, " +
      "colorful live stream studio background with LED lights, product display stand, " +
      "excited pitch expression, microphone visible, live chat bubbles floating, " +
      "authentic Thai live commerce atmosphere, vertical 9:16 format, dynamic energy"
  },

  // นางแบบคู่สินค้า — เน้นความสวยและ branding
  model_with_product: {
    id: "model_with_product",
    label: "นางแบบคู่สินค้า (Model)",
    template:
      "Beautiful Thai female model posing elegantly with {{PRODUCT}}, " +
      "fashion editorial style, professional studio lighting, " +
      "confident pose showcasing the product naturally, clean aesthetic background, " +
      "high fashion photography, flawless skin retouching, soft glow, " +
      "brand advertising campaign look, premium lifestyle vibe, " +
      "magazine cover quality, warm cinematic color grading"
  },

  // ภาพล้อเลียนหัวโตสไตล์การ์ตูน — เรียกความสนใจ ตลก
  big_head: {
    id: "big_head",
    label: "ล้อเลียนคนจริงหัวโตสไตล์การ์ตูน (Big Head)",
    template:
      "Funny caricature of a Thai person with exaggerated oversized head holding {{PRODUCT}}, " +
      "cartoon big head style, hilarious shocked expression with huge eyes, " +
      "vibrant cartoon colors, comedic promotional poster, eye-catching meme aesthetic, " +
      "bold outline style, bright background with motion lines, " +
      "Thai street marketing vibe, playful advertising illustration, viral meme quality"
  }
};

// ฟังก์ชัน helper: แทนค่า {{PRODUCT}} ใน template ด้วยชื่อสินค้าจริง
function buildPrompt(styleId, productName) {
  const tpl = PROMPT_TEMPLATES[styleId];
  if (!tpl) return "";
  // แทน placeholder ทุกตำแหน่งด้วยชื่อสินค้าที่ user กรอกมา
  return tpl.template.replace(/\{\{PRODUCT\}\}/g, productName || "the product");
}

// Export สำหรับใช้งานใน popup.js และ content.js
// ในบริบท Chrome Extension (content script และ popup script) ตัวแปร global
// จะถูก share ผ่าน window scope ของแต่ละ context โดยอัตโนมัติเมื่อ include ผ่าน manifest
if (typeof window !== "undefined") {
  window.PROMPT_TEMPLATES = PROMPT_TEMPLATES;
  window.buildPrompt = buildPrompt;
}
