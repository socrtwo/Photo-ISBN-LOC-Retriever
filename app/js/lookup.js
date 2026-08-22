// Resolve a detected book (title/author/publisher clues) to ISBN-13 / ISBN-10 / LCCN
// using Open Library and Google Books. When the spine doesn't identify the exact
// edition, pick the most likely edition's numbers and mark the result "guessed".

import { normalizeIsbn, normalizeLccn } from "./isbn.js";

const OL_FIELDS = "key,title,author_name,isbn,lccn,publisher,first_publish_year,edition_count";

function titleSimilarity(a, b) {
  const norm = (s) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const ta = new Set(norm(a).split(" "));
  const tb = new Set(norm(b).split(" "));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned ${r.status}`);
  return r.json();
}

async function searchOpenLibrary(book) {
  const params = new URLSearchParams({ limit: "5", fields: OL_FIELDS });
  params.set("title", book.title);
  if (book.author) params.set("author", book.author);
  let data = await fetchJson(`https://openlibrary.org/search.json?${params}`);

  if (!data.docs?.length && book.author) {
    // Author may have been misread — retry on title alone.
    const p2 = new URLSearchParams({ limit: "5", fields: OL_FIELDS, title: book.title });
    data = await fetchJson(`https://openlibrary.org/search.json?${p2}`);
  }
  if (!data.docs?.length) return null;

  let best = null;
  let bestScore = 0;
  for (const doc of data.docs) {
    let score = titleSimilarity(book.title, doc.title || "");
    if (book.author && doc.author_name?.length) {
      const authorHit = doc.author_name.some(
        (a) => titleSimilarity(book.author, a) > 0.5
      );
      score += authorHit ? 0.4 : -0.15;
    }
    score += Math.min(0.2, (doc.edition_count || 0) / 500); // mild popularity prior
    if (score > bestScore) { bestScore = score; best = doc; }
  }
  return bestScore >= 0.45 ? best : null;
}

// When a publisher was visible on the spine, try to pin the edition by scanning
// the work's edition list for a publisher match.
async function pinEditionByPublisher(workKey, publisher) {
  try {
    const data = await fetchJson(
      `https://openlibrary.org${workKey}/editions.json?limit=100`
    );
    const want = publisher.toLowerCase();
    for (const ed of data.entries ?? []) {
      const pubs = (ed.publishers ?? []).map((p) => p.toLowerCase());
      if (!pubs.some((p) => p.includes(want) || want.includes(p))) continue;
      const isbnRaw = ed.isbn_13?.[0] ?? ed.isbn_10?.[0];
      const isbn = isbnRaw ? normalizeIsbn(isbnRaw) : null;
      const lccn = ed.lccn?.[0] ? normalizeLccn(ed.lccn[0]) : null;
      if (isbn || lccn) return { isbn, lccn, publisher: ed.publishers?.[0] };
    }
  } catch {
    // editions endpoint is best-effort; fall through to the aggregate guess
  }
  return null;
}

async function searchGoogleBooks(book) {
  const q = [`intitle:"${book.title}"`];
  if (book.author) q.push(`inauthor:"${book.author}"`);
  const url =
    "https://www.googleapis.com/books/v1/volumes?maxResults=5&printType=books&q=" +
    encodeURIComponent(q.join(" "));
  try {
    const data = await fetchJson(url);
    for (const item of data.items ?? []) {
      const info = item.volumeInfo ?? {};
      if (titleSimilarity(book.title, info.title || "") < 0.45) continue;
      for (const id of info.industryIdentifiers ?? []) {
        if (id.type === "ISBN_13" || id.type === "ISBN_10") {
          const isbn = normalizeIsbn(id.identifier);
          if (isbn) return { isbn, title: info.title, authors: info.authors };
        }
      }
    }
  } catch {
    // Google Books is a bonus source; ignore failures (e.g. rate limiting)
  }
  return null;
}

function collectAlternates(doc, limit = 8) {
  const seen = new Set();
  const alts = [];
  for (const raw of doc?.isbn ?? []) {
    const isbn = normalizeIsbn(raw);
    if (!isbn || seen.has(isbn.isbn13)) continue;
    seen.add(isbn.isbn13);
    alts.push(isbn);
    if (alts.length >= limit) break;
  }
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

  // 1. Open Library work-level search.
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

    // 2. Publisher visible on the spine → try to pin the exact edition.
    if (!result.isbn13 && book.publisher && doc.key && (doc.edition_count ?? 0) > 1) {
      const pinned = await pinEditionByPublisher(doc.key, book.publisher);
      if (pinned?.isbn) {
        Object.assign(result, pinned.isbn);
        if (pinned.lccn) result.lccn = pinned.lccn;
        result.matchKind = "pinned";
        result.source = `edition matched by publisher (${pinned.publisher})`;
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
    return result;
  }

  result.source ||= "no match found — check the title/author spelling";
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
    await new Promise((r) => setTimeout(r, 350));
  }
  return out;
}
