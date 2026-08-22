import { extractBooks } from "./vision.js";
import { extractLines } from "./ocr.js";
import { lookupAll } from "./lookup.js";
import { isbnList, lccnList, toCsv, toTsv, copyText, downloadFile } from "./export.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  photos: [], // { img: HTMLImageElement, name }
  detected: [],
  results: [],
};

/* ---------------- Photos ---------------- */

const gallery = $("#gallery");
const galleryActions = $("#gallery-actions");
const extractBtn = $("#extract-btn");

function renderGallery() {
  gallery.innerHTML = "";
  for (let i = 0; i < state.photos.length; i++) {
    const { img, name } = state.photos[i];
    const fig = document.createElement("figure");
    const thumb = document.createElement("img");
    thumb.src = img.src;
    thumb.alt = name;
    const cap = document.createElement("figcaption");
    cap.textContent = `${name} (${img.naturalWidth}×${img.naturalHeight})`;
    const rm = document.createElement("button");
    rm.className = "remove-photo";
    rm.textContent = "✕";
    rm.title = "Remove this photo";
    rm.addEventListener("click", () => {
      state.photos.splice(i, 1);
      renderGallery();
    });
    fig.append(thumb, rm, cap);
    gallery.appendChild(fig);
  }
  const have = state.photos.length > 0;
  gallery.hidden = !have;
  galleryActions.hidden = !have;
  extractBtn.disabled = !have;
  extractBtn.textContent = have
    ? `Read the spines in ${state.photos.length} photo${state.photos.length > 1 ? "s" : ""} →`
    : "Read the spines →";
}

function addImageFromBlob(blob, name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      state.photos.push({ img, name });
      resolve();
    };
    img.onerror = () => reject(new Error(`Could not read ${name} as an image`));
    img.src = URL.createObjectURL(blob);
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.startsWith("image/")) continue;
    try {
      await addImageFromBlob(file, file.name);
    } catch (err) {
      console.warn(err);
    }
  }
  renderGallery();
}

// Snapshot the FileList BEFORE clearing the input: FileList is live, and
// resetting .value empties it while the async add-loop is still reading it.
$("#file-input").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  addFiles(files);
});
$("#capture-input").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  addFiles(files);
});
$("#clear-photos").addEventListener("click", () => {
  state.photos = [];
  renderGallery();
});

const dropZone = $("#drop-zone");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* -------- Webcam capture (desktop) -------- */

const cameraDialog = $("#camera-dialog");
const cameraVideo = $("#camera-video");
let cameraStream = null;

$("#webcam-btn").addEventListener("click", async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 4096 }, height: { ideal: 2160 } },
    });
  } catch (err) {
    showStatus($("#extract-status"), `Camera unavailable: ${err.message}`, true);
    return;
  }
  cameraVideo.srcObject = cameraStream;
  cameraDialog.showModal();
});

function stopCamera() {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cameraVideo.srcObject = null;
  cameraDialog.close();
}

$("#camera-shoot").addEventListener("click", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  canvas.getContext("2d").drawImage(cameraVideo, 0, 0);
  stopCamera();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.95));
  await addImageFromBlob(blob, `camera-${state.photos.length + 1}.jpg`);
  renderGallery();
});
$("#camera-cancel").addEventListener("click", stopCamera);

/* ---------------- Engine settings ---------------- */

const apiKeyInput = $("#api-key");
const rememberKey = $("#remember-key");
const claudeSettings = $("#claude-settings");

const savedKey = localStorage.getItem("anthropic-api-key");
if (savedKey) {
  apiKeyInput.value = savedKey;
  rememberKey.checked = true;
}
apiKeyInput.addEventListener("change", () => {
  if (rememberKey.checked) localStorage.setItem("anthropic-api-key", apiKeyInput.value.trim());
});
rememberKey.addEventListener("change", () => {
  if (rememberKey.checked) localStorage.setItem("anthropic-api-key", apiKeyInput.value.trim());
  else localStorage.removeItem("anthropic-api-key");
});

function currentEngine() {
  return document.querySelector('input[name="engine"]:checked').value;
}
for (const radio of document.querySelectorAll('input[name="engine"]')) {
  radio.addEventListener("change", () => {
    claudeSettings.style.display = currentEngine() === "claude" ? "" : "none";
  });
}

/* ---------------- Status helper ---------------- */

function showStatus(el, msg, isError = false) {
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("error", isError);
}
function hideStatus(el) {
  el.hidden = true;
}

/* ---------------- Step 2: extraction ---------------- */

function dedupeBooks(books) {
  const seen = new Map();
  for (const b of books) {
    const key = (b.title + "|" + b.author).toLowerCase().replace(/[^a-z0-9|]/g, "");
    const prev = seen.get(key);
    if (!prev || b.confidence > prev.confidence) seen.set(key, b);
  }
  return [...seen.values()];
}

extractBtn.addEventListener("click", async () => {
  const status = $("#extract-status");
  extractBtn.disabled = true;
  try {
    const sources = state.photos.map((p) => p.img);
    let books;
    if (currentEngine() === "claude") {
      const apiKey = apiKeyInput.value.trim();
      if (!apiKey) throw new Error("Enter your Anthropic API key (or switch to local OCR).");
      if (rememberKey.checked) localStorage.setItem("anthropic-api-key", apiKey);
      const model = $("#model-select").value;
      books = await extractBooks({
        sources, apiKey, model,
        onProgress: (msg) => showStatus(status, msg),
      });
    } else {
      books = await extractLines({
        sources,
        onProgress: (msg) => showStatus(status, msg),
      });
    }
    state.detected = dedupeBooks(books);
    if (!state.detected.length) {
      showStatus(status, "No books detected — try a sharper or closer photo.", true);
      return;
    }
    showStatus(status, `Detected ${state.detected.length} book(s). Review them below.`);
    renderDetected();
    $("#step-review").hidden = false;
    $("#step-review").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    showStatus(status, String(err.message || err), true);
  } finally {
    extractBtn.disabled = state.photos.length === 0;
  }
});

/* ---------------- Step 3: review ---------------- */

function renderDetected() {
  const tbody = $("#detected-table tbody");
  tbody.innerHTML = "";
  state.detected.forEach((book, i) => {
    const tr = document.createElement("tr");
    for (const field of ["title", "author", "publisher"]) {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.value = book[field] || "";
      input.placeholder = field;
      input.addEventListener("input", () => (state.detected[i][field] = input.value));
      td.appendChild(input);
      tr.appendChild(td);
    }
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del-btn";
    del.textContent = "🗑";
    del.title = "Remove";
    del.addEventListener("click", () => {
      state.detected.splice(i, 1);
      renderDetected();
    });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
}

$("#add-row-btn").addEventListener("click", () => {
  state.detected.push({
    title: "", author: "", publisher: "", edition_clues: "",
    visible_isbn: "", visible_lccn: "", confidence: 1,
  });
  renderDetected();
  const inputs = $("#detected-table tbody").querySelectorAll("input");
  inputs[inputs.length - 3]?.focus();
});

/* ---------------- Step 4: lookup + results ---------------- */

$("#lookup-btn").addEventListener("click", async () => {
  const status = $("#lookup-status");
  const btn = $("#lookup-btn");
  const books = state.detected.filter((b) => b.title.trim());
  if (!books.length) {
    showStatus(status, "No books to look up.", true);
    return;
  }
  btn.disabled = true;
  try {
    state.results = await lookupAll(books, (i, n, book) =>
      showStatus(status, `Looking up ${i + 1}/${n}: ${book.title}`)
    );
    hideStatus(status);
    renderResults();
    $("#step-results").hidden = false;
    $("#step-results").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    showStatus(status, String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

const MATCH_LABEL = {
  spine: ["spine", "number printed on the spine"],
  pinned: ["edition", "edition pinned by publisher"],
  guessed: ["guessed", "most likely edition"],
  none: ["none", "no match"],
};

function renderResults() {
  const tbody = $("#results-table tbody");
  tbody.innerHTML = "";
  state.results.forEach((r, i) => {
    const tr = document.createElement("tr");

    const tdCheck = document.createElement("td");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = r.selected !== false;
    check.addEventListener("change", () => (state.results[i].selected = check.checked));
    if (r.selected === undefined) r.selected = true;
    tdCheck.appendChild(check);

    const tdAuthor = document.createElement("td");
    tdAuthor.textContent = r.author || "—";
    const tdTitle = document.createElement("td");
    tdTitle.textContent = r.title;

    const td13 = document.createElement("td");
    td13.className = "mono";
    td13.textContent = r.isbn13 || "—";
    const td10 = document.createElement("td");
    td10.className = "mono";
    td10.textContent = r.isbn10 || "—";
    const tdLccn = document.createElement("td");
    tdLccn.className = "mono";
    tdLccn.textContent = r.lccn || "—";

    const tdMatch = document.createElement("td");
    const [label, title] = MATCH_LABEL[r.matchKind] || MATCH_LABEL.none;
    const badge = document.createElement("span");
    badge.className = `badge ${r.matchKind === "none" ? "none" : r.matchKind === "guessed" ? "guessed" : "spine"}`;
    badge.textContent = label;
    badge.title = `${title}${r.source ? " — " + r.source : ""}`;
    tdMatch.appendChild(badge);

    const tdAlt = document.createElement("td");
    if (r.alternates?.length > 1) {
      const details = document.createElement("details");
      details.className = "alt-details";
      const summary = document.createElement("summary");
      summary.textContent = `${r.alternates.length} alternates`;
      details.appendChild(summary);
      const ul = document.createElement("ul");
      ul.className = "alt-list";
      for (const alt of r.alternates) {
        const li = document.createElement("li");
        const pick = document.createElement("button");
        pick.className = "mono";
        pick.textContent = alt.isbn13;
        pick.title = "Use this edition's ISBN instead";
        pick.addEventListener("click", () => {
          state.results[i].isbn13 = alt.isbn13;
          state.results[i].isbn10 = alt.isbn10;
          renderResults();
        });
        li.appendChild(pick);
        ul.appendChild(li);
      }
      details.appendChild(ul);
      tdAlt.appendChild(details);
    }

    tr.append(tdCheck, tdAuthor, tdTitle, td13, td10, tdLccn, tdMatch, tdAlt);
    tbody.appendChild(tr);
  });
}

$("#check-all").addEventListener("change", (e) => {
  for (const r of state.results) r.selected = e.target.checked;
  renderResults();
});

/* ---------------- Exports ---------------- */

function selectedRows() {
  return state.results.filter((r) => r.selected !== false);
}

function flashCopyStatus(msg, isError = false) {
  const el = $("#copy-status");
  showStatus(el, msg, isError);
  setTimeout(() => hideStatus(el), 4000);
}

$("#copy-isbns").addEventListener("click", async () => {
  const text = isbnList(selectedRows());
  if (!text) return flashCopyStatus("No ISBNs among the selected rows.", true);
  await copyText(text);
  flashCopyStatus(
    `Copied ${text.split("\n").length} ISBN(s). Paste them into LibraryThing → Import.`
  );
});

$("#copy-lccns").addEventListener("click", async () => {
  const text = lccnList(selectedRows());
  if (!text) return flashCopyStatus("No LCCNs among the selected rows.", true);
  await copyText(text);
  flashCopyStatus(`Copied ${text.split("\n").length} LCCN(s).`);
});

$("#copy-tsv").addEventListener("click", async () => {
  await copyText(toTsv(selectedRows()));
  flashCopyStatus("Copied the table (tab-separated).");
});

$("#download-csv").addEventListener("click", () => {
  downloadFile("shelf-snap-books.csv", toCsv(selectedRows()));
});

/* ---------------- PWA ---------------- */

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

renderGallery();
