// Book-spine extraction using the Anthropic API (official SDK, loaded on demand).

const SDK_URL = "https://esm.sh/@anthropic-ai/sdk";
const MAX_SIDE = 1568; // Claude downsizes anything larger; pre-tiling keeps spine text legible

let AnthropicPromise = null;
function loadSdk() {
  if (!AnthropicPromise) {
    AnthropicPromise = import(SDK_URL).then((m) => m.default);
  }
  return AnthropicPromise;
}

const PROMPT = `These images are overlapping crops of photograph(s) of book spines on shelves.

List every distinct book whose spine is visible. Because the crops overlap, the same
book may appear in more than one image — list each book only once.

For each book report:
- "title": the title as printed (expand obvious truncations if you are confident)
- "author": the author's full name if known; if the spine shows only a surname and you
  recognize the book, give the full name
- "publisher": the publisher name/colophon if visible on the spine, else ""
- "edition_clues": anything visible that narrows the edition (format, series, "Book Club
  Edition", volume number, jacket style), else ""
- "visible_isbn": an ISBN if one is actually printed and legible on the spine, else ""
- "visible_lccn": a Library of Congress catalog/call number if printed and legible, else ""
- "confidence": 0-1, your confidence that title and author are read correctly

Include books even when the text is partly obscured — make your best identification and
lower the confidence. Ignore non-book objects.

Respond with ONLY a JSON object, no other text:
{"books": [{"title": "...", "author": "...", "publisher": "...", "edition_clues": "...",
"visible_isbn": "...", "visible_lccn": "...", "confidence": 0.9}]}`;

// Split a shelf photo into overlapping tiles so small spine text survives the
// model's input resizing. Wide photos are cut into vertical strips, tall photos
// into horizontal bands.
export function tileImage(source) {
  const w = source.width ?? source.naturalWidth;
  const h = source.height ?? source.naturalHeight;
  const wide = w >= h;
  const long = wide ? w : h;
  const short = wide ? h : w;

  let n = Math.min(4, Math.max(1, Math.round(long / (short * 1.3))));
  const overlap = 0.12;
  const step = long / (n - (n - 1) * overlap);

  const tiles = [];
  for (let i = 0; i < n; i++) {
    const start = Math.round(i * step * (1 - overlap));
    const len = Math.min(Math.round(step), long - start);
    const [sx, sy, sw, sh] = wide ? [start, 0, len, h] : [0, start, w, len];

    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    tiles.push(canvas);
  }
  return tiles;
}

function canvasToBase64Jpeg(canvas, quality = 0.9) {
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

function parseBooksJson(text) {
  // Strip code fences / surrounding prose, then parse the outermost JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model returned no JSON.");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.books)) throw new Error("The model's JSON had no \"books\" list.");
  return parsed.books
    .filter((b) => b && b.title)
    .map((b) => ({
      title: String(b.title).trim(),
      author: String(b.author || "").trim(),
      publisher: String(b.publisher || "").trim(),
      edition_clues: String(b.edition_clues || "").trim(),
      visible_isbn: String(b.visible_isbn || "").trim(),
      visible_lccn: String(b.visible_lccn || "").trim(),
      confidence: typeof b.confidence === "number" ? b.confidence : 0.5,
    }));
}

// Extract books from one or more photos. `sources` are <img>/canvas elements.
// One API request per photo (each photo becomes several overlapping tiles);
// results are merged and de-duplicated by the caller.
export async function extractBooks({ sources, apiKey, model, onProgress }) {
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const all = [];
  for (let i = 0; i < sources.length; i++) {
    onProgress?.(`Reading photo ${i + 1} of ${sources.length}…`);
    const tiles = tileImage(sources[i]);
    const content = tiles.map((t) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: canvasToBase64Jpeg(t) },
    }));
    content.push({ type: "text", text: PROMPT });

    try {
      const response = await client.messages.create({
        model,
        max_tokens: 16000,
        messages: [{ role: "user", content }],
      });
      if (response.stop_reason === "refusal") {
        throw new Error("The model declined to process this image.");
      }
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      all.push(...parseBooksJson(text));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error("Invalid Anthropic API key — check the key and try again.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error("Anthropic API rate limit hit — wait a minute and try again.");
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error ${err.status}: ${err.message}`);
      }
      throw err;
    }
  }
  return all;
}
