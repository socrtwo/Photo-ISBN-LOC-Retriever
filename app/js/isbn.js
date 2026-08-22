// ISBN validation and conversion helpers.

export function cleanIsbn(raw) {
  return String(raw || "").replace(/[^0-9Xx]/g, "").toUpperCase();
}

export function isValidIsbn10(isbn) {
  const s = cleanIsbn(isbn);
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const v = s[i] === "X" ? 10 : Number(s[i]);
    sum += v * (10 - i);
  }
  return sum % 11 === 0;
}

export function isValidIsbn13(isbn) {
  const s = cleanIsbn(isbn);
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function isbn10to13(isbn10) {
  const s = cleanIsbn(isbn10);
  if (!isValidIsbn10(s)) return null;
  const core = "978" + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

export function isbn13to10(isbn13) {
  const s = cleanIsbn(isbn13);
  if (!isValidIsbn13(s) || !s.startsWith("978")) return null;
  const core = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const rem = (11 - (sum % 11)) % 11;
  return core + (rem === 10 ? "X" : String(rem));
}

// Normalize whatever an API or a spine gave us into {isbn13, isbn10}.
export function normalizeIsbn(raw) {
  const s = cleanIsbn(raw);
  if (isValidIsbn13(s)) return { isbn13: s, isbn10: isbn13to10(s) };
  if (isValidIsbn10(s)) return { isbn13: isbn10to13(s), isbn10: s };
  return null;
}

// LCCNs are loosely structured; just tidy whitespace/hyphens per LoC normalization rules.
export function normalizeLccn(raw) {
  let s = String(raw || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const hy = s.indexOf("-");
  if (hy >= 0) {
    // Pad the serial after the hyphen to 6 digits: 85-2 -> 85000002
    const head = s.slice(0, hy);
    const tail = s.slice(hy + 1).replace(/\D/g, "");
    s = head + tail.padStart(6, "0");
  }
  return /^[a-z]{0,3}\d{8,10}$/.test(s) ? s : String(raw).trim();
}
