// Local, in-browser OCR fallback using Tesseract.js.
// Spine text is usually rotated 90°, so each photo is OCR'd at 0°, 90° and 270°
// and the recognized lines are pooled. This is far rougher than the AI mode —
// the review step lets the user clean the lines up before lookup.

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve(window.Tesseract);
      const s = document.createElement("script");
      s.src = TESSERACT_URL;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error("Could not load Tesseract.js (are you offline?)"));
      document.head.appendChild(s);
    });
  }
  return tesseractPromise;
}

function rotated(source, deg) {
  const w = source.width ?? source.naturalWidth;
  const h = source.height ?? source.naturalHeight;
  const canvas = document.createElement("canvas");
  if (deg === 0) {
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(source, 0, 0);
  } else {
    canvas.width = h; canvas.height = w;
    const ctx = canvas.getContext("2d");
    ctx.translate(h / 2, w / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(source, -w / 2, -h / 2);
  }
  return canvas;
}

function cleanLine(text) {
  return text
    .replace(/[|_~`^\\{}<>=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeText(line) {
  if (line.length < 4) return false;
  const letters = (line.match(/[A-Za-z]/g) || []).length;
  return letters / line.length >= 0.5 && letters >= 4;
}

export async function extractLines({ sources, onProgress }) {
  const Tesseract = await loadTesseract();
  const worker = await Tesseract.createWorker("eng");
  const found = new Map(); // lowercased line -> original

  try {
    for (let i = 0; i < sources.length; i++) {
      for (const deg of [0, 90, 270]) {
        onProgress?.(`OCR photo ${i + 1}/${sources.length} at ${deg}°…`);
        const { data } = await worker.recognize(rotated(sources[i], deg));
        for (const lineObj of data.lines ?? []) {
          if ((lineObj.confidence ?? 0) < 55) continue;
          const line = cleanLine(lineObj.text);
          if (!looksLikeText(line)) continue;
          const key = line.toLowerCase();
          if (!found.has(key)) found.set(key, line);
        }
      }
    }
  } finally {
    await worker.terminate();
  }

  // Each surviving line becomes a candidate title for the user to review.
  return [...found.values()].map((line) => ({
    title: line,
    author: "",
    publisher: "",
    edition_clues: "",
    visible_isbn: "",
    visible_lccn: "",
    confidence: 0.3,
  }));
}
