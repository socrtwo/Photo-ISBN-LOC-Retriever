// Turn results into LibraryThing-ready lists and files.

export function isbnList(rows) {
  return rows
    .map((r) => r.isbn13 || r.isbn10)
    .filter(Boolean)
    .join("\n");
}

export function lccnList(rows) {
  return rows.map((r) => r.lccn).filter(Boolean).join("\n");
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = ["Author", "Title", "ISBN-13", "ISBN-10", "LCCN", "Match"];

export function toCsv(rows) {
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [r.author, r.title, r.isbn13, r.isbn10, r.lccn, r.matchKind]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function toTsv(rows) {
  const lines = [HEADER.join("\t")];
  for (const r of rows) {
    lines.push(
      [r.author, r.title, r.isbn13, r.isbn10, r.lccn, r.matchKind]
        .map((v) => String(v ?? "").replace(/\t/g, " "))
        .join("\t")
    );
  }
  return lines.join("\n");
}

export async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

export function downloadFile(name, text, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
