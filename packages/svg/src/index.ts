import type { OpenCncDocument, Point } from "../../core/src/index.js";

const esc = (value: string): string => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const points = (path: Point[]): string => path.map(p => `${p.x},${p.y}`).join(" ");

export function renderSvg(document: OpenCncDocument): string {
  const width = document.panel.width ?? 1000;
  const height = document.panel.height ?? 600;
  const shapes = document.operations.flatMap(operation => {
    if (operation.path?.length) return [`<polyline points="${points(operation.path)}" fill="none" stroke="#2563eb" stroke-width="1" />`];
    if (operation.position) return [`<circle cx="${operation.position.x}" cy="${operation.position.y}" r="${Math.max(1, (operation.diameter ?? 4) / 2)}" fill="#dc2626"><title>${esc(operation.id)}</title></circle>`];
    return [];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="OpenCNC panel preview">\n  <rect width="${width}" height="${height}" fill="#f5deb3" stroke="#292524" stroke-width="2" />\n  ${shapes.join("\n  ")}\n</svg>\n`;
}

