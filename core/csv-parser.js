/**
 * Client-side CSV parser. Converts raw CSV text into structured
 * record objects keyed by header row. Handles quoted fields containing
 * commas or escaped quotes.
 */

/**
 * Parses a single CSV line into an array of field values, honoring
 * double-quote escaping and quoted commas.
 */
function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parses raw CSV text (with a header row) into an array of record objects.
 * Blank lines are skipped. Returns { headers, records }.
 */
export function parseCSV(rawText) {
  const lines = rawText
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { headers: [], records: [] };
  }

  const headers = parseLine(lines[0]).map((h) => h.trim());
  const records = lines.slice(1).map((line) => {
    const values = parseLine(line);
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = (values[idx] ?? '').trim();
    });
    return record;
  });

  return { headers, records };
}
