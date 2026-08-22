// Resolve a detected book (title/author/publisher clues) to ISBN-13 / ISBN-10 / LCCN
// using Open Library and Google Books. When the spine doesn't identify the exact
// edition, pick the most likely edition's numbers and mark the result "guessed".

import { normalizeIsbn, normalizeLccn } from "./isbn.js";

const OL_FIELDS =
  "key,title,author_name,isbn,lccn,publisher,first_publish_year,edition_count";

function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mainTitle(s) {
  // "Social Conflict: Escalation, Stalemate and Settlement" -> "Social Conflict"
  const cut = String(s || "").split(/[:;]|\s[-–—]\s/)[0].trim();
  return cut || s;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "in", "on", "for", "to", "is"]);
function tokens(s) {
  return new Set(normTitle(s).split(" ").filter((w) => w && !STOPWORDS.has(w)));
}

// Containment similarity: how much of the SHORTER title is inside the longer.
// Subtitles present on one side but not the other don't tank the score.
function titleSimilarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

function authorMatches(author, names) {
  if (!author || !names?.length) return false;
  const want = tokens(author);
  if (!want.size) return false;
  return names.some((name) => {
    const have = tokens(name);
    // A spine often shows just a surname — one shared name token is a match.
    for (const w of want) if (have.has(w)) return true;
    return false;
  });
}

async function fetchJson(url, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && attempt < retries) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`${new URL(url).hostname} returned ${r.status}`);
  }
}

function scoreDoc(doc, book) {
  const full = titleSimilarity(book.title, doc.title || "");
  const main = titleSimilarity(mainTitle(book.title), doc.title || "");
  let score = Math.max(full, main * 0.95);
  const authorHit = authorMatches(book.author, doc.author_name);
  if (book.author) score += authorHit ? 0.35 : -0.1;
  score += Math.min(0.15, (doc.edition_count || 0) / 500); // mild popularity prior
  return { score, authorHit };
}

async function searchOpenLibrary(book) {
  const attempts = [];
  const t = book.title;
  const mt = mainTitle(book.title);
  if (book.author) attempts.push({ title: t, author: book.author });
  attempts.push({ title: t });
  if (mt !== t) {
    if (book.author) attempts.push({ title: mt, author: book.author });
    attempts.push({ title: mt });
  }
  attempts.push({ q: `${mt} ${book.author || ""}`.trim() });

  let best = null;
  let bestScore = 0;
  let bestAuthorHit = false;
  for (const attempt of attempts) {
    const params = new URLSearchParams({ limit: "5", fields: OL_FIELDS });
    for (const [k, v] of Object.entries(attempt)) params.set(k, v);
    let data;
    try {
      data = await fetchJson(`https://openlibrary.org/search.json?${params}`);
    } catch {
      continue; // try the next query shape
    }
    for (const doc of data.docs ?? []) {
      const { score, authorHit } = scoreDoc(doc, book);
      if (score > bestScore) {
        best = doc;
        bestScore = score;
        bestAuthorHit = authorHit;
      }
    }
    // A confident match ends the search early; a weak one keeps trying shapes.
    if (bestScore >= 0.9) break;
  }
  // Accept a weaker title match when the author corroborates it.
  const threshold = bestAuthorHit ? 0.55 : 0.75;
  return bestScore >= threshold ? best : null;
}

// Scan the work's edition list. With a publisher clue we try to pin the exact
// edition; without one we still use it to find ISBNs the search doc lacked.
async function scanEditions(workKey, publisher) {
  const out = { pinned: null, isbns: [], lccns: [] };
  let data;
  try {
    data = await fetchJson(`https://openlibrary.org${workKey}/editions.json?limit=100`);
  } catch {
    return out;
  }
  const want = publisher ? normTitle(publisher) : null;
  for (const ed of data.entries ?? []) {
    const isbnRaw = ed.isbn_13?.[0] ?? ed.isbn_10?.[0];
    const isbn = isbnRaw ? normalizeIsbn(isbnRaw) : null;
    const lccn = ed.lccn?.[0] ? normalizeLccn(ed.lccn[0]) : null;
    if (isbn) out.isbns.push(isbn);
    if (lccn) out.lccns.push(lccn);
    if (want && !out.pinned && (isbn || lccn)) {
      const pubs = (ed.publishers ?? []).map((p) => normTitle(p));
      if (pubs.some((p) => p.includes(want) || want.includes(p))) {
        out.pinned = { isbn, lccn, publisher: ed.publishers?.[0] };
      }
    }
  }
  return out;
}

async function searchGoogleBooks(book) {
  const mt = mainTitle(book.title);
  const queries = [];
  {
    const q = [`intitle:"${mt}"`];
    if (book.author) q.push(`inauthor:"${book.author}"`);
    queries.push(q.join(" "));
  }
  queries.push(`${mt} ${book.author || ""}`.trim()); // unquoted fallback

  for (const q of queries) {
    let data;
    try {
      data = await fetchJson(
        "https://www.googleapis.com/books/v1/volumes?maxResults=5&printType=books&q=" +
          encodeURIComponent(q),
        2 // Google 429s freely without an API key — retry with backoff
      );
    } catch {
      continue;
    }
    for (const item of data.items ?? []) {
      const info = item.volumeInfo ?? {};
      if (titleSimilarity(book.title, info.title || "") < 0.6) continue;
      if (book.author && !authorMatches(book.author, info.authors)) continue;
      for (const id of info.industryIdentifiers ?? []) {
        if (id.type === "ISBN_13" || id.type === "ISBN_10") {
          const isbn = normalizeIsbn(id.identifier);
          if (isbn) return { isbn, title: info.title, authors: info.authors };
        }
      }
    }
  }
  return null;
}

function collectAlternates(doc, extra = [], limit = 8) {
  const seen = new Set();
  const alts = [];
  const push = (isbn) => {
    if (isbn && !seen.has(isbn.isbn13) && alts.length < limit) {
      seen.add(isbn.isbn13);
      alts.push(isbn);
    }
  };
  for (const raw of doc?.isbn ?? []) push(normalizeIsbn(raw));
  for (const isbn of extra) push(isbn);
  return alts;
}

// Returns:
// { title, author, isbn13, isbn10, lccn, matchKind: "spine"|"pinned"|"guessed"|"none",
//   source, alternates: [{isbn13, isbn10}] }
export async function lookupBook(book) {
  const result = {
    title: book.title,
    author: book.author,
    isbn13: null,
    isbn10: null,
    lccn: null,
    matchKind: "none",
    source: "",
    alternates: [],
  };

  // 0. An ISBN/LCCN printed on the spine wins outright.
  const spineIsbn = book.visible_isbn ? normalizeIsbn(book.visible_isbn) : null;
  const spineLccn = book.visible_lccn ? normalizeLccn(book.visible_lccn) : null;
  if (spineIsbn) {
    Object.assign(result, spineIsbn, { matchKind: "spine", source: "printed on spine" });
  }
  if (spineLccn) {
    result.lccn = spineLccn;
    if (result.matchKind === "none") {
      result.matchKind = "spine";
      result.source = "printed on spine";
    }
  }
  if (result.matchKind === "spine" && result.isbn13) return result;

  // 1. Open Library work-level search (several query shapes).
  let doc = null;
  try {
    doc = await searchOpenLibrary(book);
  } catch (err) {
    result.source = `Open Library error: ${err.message}`;
  }

  if (doc) {
    if (doc.title) result.title = doc.title;
    if (!result.author && doc.author_name?.length) result.author = doc.author_name[0];
    result.alternates = collectAlternates(doc);
    if (!result.lccn && doc.lccn?.length) result.lccn = normalizeLccn(doc.lccn[0]);

    // 2. Scan the edition list when we need more than the search doc offers:
    //    to pin by publisher, or to find any ISBN/LCCN at all.
    const needScan =
      doc.key &&
      ((book.publisher && (doc.edition_count ?? 0) > 1) ||
        (!result.isbn13 && !result.alternates.length) ||
        !result.lccn);
    if (needScan) {
      const scan = await scanEditions(doc.key, book.publisher);
      result.alternates = collectAlternates(doc, scan.isbns);
      if (!result.lccn && scan.lccns.length) result.lccn = scan.lccns[0];
      if (scan.pinned?.isbn && !result.isbn13) {
        Object.assign(result, scan.pinned.isbn);
        if (scan.pinned.lccn) result.lccn ||= scan.pinned.lccn;
        result.matchKind = "pinned";
        result.source = `edition matched by publisher (${scan.pinned.publisher})`;
        return result;
      }
    }
  }

  // 3. Google Books relevance ranking as the "most likely edition" guess.
  if (!result.isbn13) {
    const g = await searchGoogleBooks(book);
    if (g) {
      Object.assign(result, g.isbn);
      if (!result.author && g.authors?.length) result.author = g.authors[0];
      result.matchKind = "guessed";
      result.source = "best guess (Google Books top match)";
      return result;
    }
  }

  // 4. Fall back to the first ISBN Open Library knows for the work.
  if (!result.isbn13 && result.alternates.length) {
    Object.assign(result, result.alternates[0]);
    result.matchKind = "guessed";
    result.source = "best guess (Open Library first edition listed)";
    return result;
  }

  if (result.isbn13 || result.lccn) {
    if (result.matchKind === "none") {
      result.matchKind = "guessed";
      result.source ||= "best guess";
    }
    if (!result.isbn13 && doc?.first_publish_year && doc.first_publish_year < 1970) {
      result.source = `no ISBN — likely pre-ISBN era (first published ${doc.first_publish_year}); use the LCCN`;
    }
    return result;
  }

  if (doc && doc.first_publish_year && doc.first_publish_year < 1970) {
    result.source = `matched "${doc.title}" but found no ISBN/LCCN — likely a pre-ISBN era book`;
  } else {
    result.source ||= "no match found — check the title/author spelling";
  }
  return result;
}

// Look up an array of detected books sequentially (politeness to the free APIs),
// reporting progress along the way.
export async function lookupAll(books, onProgress) {
  const out = [];
  for (let i = 0; i < books.length; i++) {
    onProgress?.(i, books.length, books[i]);
    try {
      out.push(await lookupBook(books[i]));
    } catch (err) {
      out.push({
        title: books[i].title,
        author: books[i].author,
        isbn13: null, isbn10: null, lccn: null,
        matchKind: "none",
        source: `lookup failed: ${err.message}`,
        alternates: [],
      });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}
