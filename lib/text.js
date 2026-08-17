function cleanSingleLine(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, maxLength);
}

function collapseNewlines(value, maxLength) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function trimSlice(value, maxLength) {
  return String(value || '').replace(/\r/g, '').trim().slice(0, maxLength);
}

module.exports = {
  cleanMultiline,
  cleanSingleLine,
  collapseNewlines,
  trimSlice
};
