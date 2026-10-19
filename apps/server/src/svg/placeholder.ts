const WIDTH = 1200;
const HEIGHT = 800;

/** A neutral SVG shown when the model fails to produce a usable sketch. */
export function placeholderSvg(title: string): string {
  const escaped = escapeXml(title);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${escaped}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#f3f4f6"/>`,
    `<text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#6b7280">${escaped}</text>`,
    "</svg>",
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
