import * as XLSX from "xlsx";
import { requireChihuNative } from "../../native/client";

export interface ParsedDelimitedFileResult {
  ok: boolean;
  canceled?: boolean;
  status?: string;
  message?: string;
  fileName?: string;
  rows?: Array<Record<string, unknown>>;
  count?: number;
}

const PRODUCT_ID_KEYS = [
  "\u5546\u54c1ID",
  "\u5546\u54c1id",
  "\u5546\u54c1 Id",
  "productId",
  "product_id",
  "goods_id",
  "goodsId",
  "item_id",
  "itemId",
  "id"
];

function normalizeProductId(row: Record<string, unknown>) {
  const productId = PRODUCT_ID_KEYS.map((key) => String(row[key] || "").trim()).find(Boolean);
  if (productId) row.productId = productId;
  return row;
}

function parseDelimitedRows(text: string): Array<Record<string, unknown>> {
  const clean = text.replace(/^\ufeff/, "");
  const delimiter = clean.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    const next = clean[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  const header = rows.shift()?.map((item) => item.trim()) || [];
  return rows
    .map((cells) => {
      const item: Record<string, unknown> = {};
      header.forEach((key, index) => {
        if (key) item[key] = cells[index] ?? "";
      });
      return normalizeProductId(item);
    })
    .filter((item) => item.productId || Object.keys(item).length > 1);
}

function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function parseWorkbook(base64: string): Array<Record<string, unknown>> {
  const workbook = XLSX.read(base64ToArrayBuffer(base64), { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" })
    .map(normalizeProductId)
    .filter((item) => item.productId || Object.keys(item).length > 1);
}

export function parseCompassFileContent(fileName: string, content: string, encoding: "utf8" | "base64" = "utf8"): ParsedDelimitedFileResult {
  const lower = fileName.toLowerCase();
  const rows = lower.endsWith(".xlsx") || lower.endsWith(".xls")
    ? parseWorkbook(encoding === "base64" ? content : btoa(content))
    : parseDelimitedRows(content);
  return {
    ok: true,
    status: "parsed",
    fileName,
    rows,
    count: rows.length,
    message: rows.length ? `Read ${rows.length} product metric rows` : "No product metric rows found"
  };
}

function workbookBase64(rows: Array<Record<string, unknown>>) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" }) as string;
}

export async function runDoudianFileImportSelfCheck() {
  const csv = parseCompassFileContent("self.csv", "\u5546\u54c1ID,\u66dd\u5149\ncsv-1,5\n");
  const tsv = parseCompassFileContent("self.txt", "product_id\tclickCount\ntsv-1\t3\n");
  const xlsx = parseCompassFileContent("self.xlsx", workbookBase64([{ "\u5546\u54c1ID": "xlsx-1", exposureCount: 7 }]), "base64");
  const csvOk = csv.ok === true && csv.rows?.[0]?.productId === "csv-1";
  const tsvOk = tsv.ok === true && tsv.rows?.[0]?.productId === "tsv-1";
  const xlsxOk = xlsx.ok === true && xlsx.rows?.[0]?.productId === "xlsx-1";
  return {
    ok: csvOk && tsvOk && xlsxOk,
    csvOk,
    tsvOk,
    xlsxOk,
    count: Number(csv.count || 0) + Number(tsv.count || 0) + Number(xlsx.count || 0)
  };
}

export async function selectAndParseCompassFile(): Promise<ParsedDelimitedFileResult> {
  const native = requireChihuNative();
  const selected = await native.files.selectFile({
    title: "Select business product file",
    filters: [
      { name: "Business product list", extensions: ["csv", "tsv", "txt", "xlsx", "xls"] },
      { name: "CSV/TSV/TXT", extensions: ["csv", "tsv", "txt"] },
      { name: "Excel", extensions: ["xlsx", "xls"] }
    ]
  });
  if (selected.canceled) return { ok: false, canceled: true, status: "canceled", rows: [] };
  if (!selected.ok || !selected.filePath) return { ok: false, status: "missing", message: "No file selected", rows: [] };
  const lower = (selected.fileName || selected.filePath).toLowerCase();
  const encoding = lower.endsWith(".xlsx") || lower.endsWith(".xls") ? "base64" : "utf8";
  const read = await native.files.readFile({ filePath: selected.filePath, encoding, maxBytes: 30 * 1024 * 1024 });
  if (!read.ok) return { ok: false, status: "read-failed", message: read.message || "File read failed", fileName: selected.fileName, rows: [] };
  return parseCompassFileContent(read.fileName || selected.fileName || "", read.content, read.encoding);
}
