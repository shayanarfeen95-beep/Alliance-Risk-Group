import { strFromU8, unzipSync } from 'fflate';

/**
 * A spreadsheet upload as a grid of strings — the shape the budget reader
 * already takes from Google Sheets.
 *
 * CSV, or the first worksheet of an .xlsx (Excel, Numbers and Google Sheets all
 * export it). Numbers stay as written; a date cell arrives as Excel's serial
 * number, which the budget reader already understands.
 */
export function readSpreadsheet(bytes: Uint8Array, fileName: string): string[][] {
  if (/\.csv$/i.test(fileName) || !looksLikeZip(bytes)) return readCsv(new TextDecoder().decode(bytes));
  return readXlsx(bytes);
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

const decodeXml = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');

/** The text runs of a shared or inline string, joined. */
const textOf = (xml: string) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join('');

function columnIndex(reference: string): number {
  const letters = reference.replace(/\d+/g, '');
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export function readXlsx(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes);
  const read = (path: string) => (files[path] ? strFromU8(files[path]!) : '');

  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));

  // The first sheet in the workbook's own order, through its relationship.
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const firstSheet = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const target = firstSheet ? rels.match(new RegExp(`Id="${firstSheet}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${firstSheet}"`))?.[1] : undefined;
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath) || read('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('The workbook has no worksheet that could be read.');

  const grid: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const cell of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '';
      const body = cell[2] ?? '';
      const reference = attributes.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attributes.match(/\bt="([^"]+)"/)?.[1];
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (raw !== undefined) value = decodeXml(raw);
      const index = reference ? columnIndex(reference) : cells.length;
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    grid.push(cells);
  }
  return grid.filter((r) => r.some((value) => value.trim() !== ''));
}
