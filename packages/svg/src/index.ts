import { operationPoints, type OpenCncDocument, type Point } from "../../core/src/index.js";

const esc = (value: string): string => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const points = (path: Point[]): string => path.map(p => `${p.x},${p.y}`).join(" ");

export function renderSvg(document: OpenCncDocument): string {
  const width = document.panel.width ?? 1000;
  const height = document.panel.height ?? 600;
  const shapes = document.operations.flatMap(operation => {
    const title = esc([operation.id, operation.sourceType, operation.label, operation.depth !== undefined ? `depth ${operation.depth}` : undefined, operation.diameter !== undefined ? `diameter ${operation.diameter}` : undefined].filter(Boolean).join(" · "));
    if (operation.path?.length) return [`<polyline points="${points(operation.path)}" fill="none" stroke="#2563eb" stroke-width="${Math.max(1, operation.diameter ?? 2)}" stroke-linecap="round" stroke-linejoin="round"><title>${title}</title></polyline>`];
    if (operation.position) return operationPoints(operation).map(position => `<circle cx="${position.x}" cy="${position.y}" r="${Math.max(1, (operation.diameter ?? 4) / 2)}" fill="${operation.face === undefined || operation.face === 0 ? "#dc2626" : "#f59e0b"}" fill-opacity="0.82"><title>${title}</title></circle>`);
    return [];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="OpenCNC panel preview">\n  <rect width="${width}" height="${height}" fill="#f5deb3" stroke="#292524" stroke-width="2" />\n  ${shapes.join("\n  ")}\n</svg>\n`;
}
