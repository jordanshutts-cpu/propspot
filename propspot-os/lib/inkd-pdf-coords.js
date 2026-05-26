// Convert a field's top-left-origin percent rect into pdf-lib's bottom-left-origin point rect.
//
// Input  rect: { x_pct, y_pct, width_pct, height_pct }  (numbers between 0 and 1)
// Input  page: pageWidthPt, pageHeightPt
// Output rect: { x, y, width, height }  (in PDF points, origin bottom-left)
function pctToPdfRect(rect, pageWidthPt, pageHeightPt) {
  const width  = rect.width_pct  * pageWidthPt;
  const height = rect.height_pct * pageHeightPt;
  const x = rect.x_pct * pageWidthPt;
  // Browser y is from top; pdf-lib y is from bottom.
  const y = pageHeightPt - (rect.y_pct * pageHeightPt) - height;
  return { x, y, width, height };
}

module.exports = { pctToPdfRect };
