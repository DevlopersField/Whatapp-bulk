/**
 * Lightweight template engine. Extracts {variable} tags from a template
 * string and compiles them against recipient record objects.
 */

const TAG_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Returns the unique set of {tag} names referenced in a template string.
 */
export function extractTags(template) {
  const tags = new Set();
  let match;
  TAG_PATTERN.lastIndex = 0;
  while ((match = TAG_PATTERN.exec(template)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

/**
 * Compiles a template string against a single recipient record, replacing
 * {tag} placeholders with matching record values. Unmatched tags are left
 * intact so missing-data issues stay visible in the preview/output.
 */
export function compileTemplate(template, record) {
  return template.replace(TAG_PATTERN, (match, key) => {
    return record[key] !== undefined ? String(record[key]).trim() : match;
  });
}
