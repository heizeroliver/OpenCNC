import { operationPoints, type ArcSegment, type OpenCncDocument, type Operation, type Point } from "../../core/src/index.js";

const esc = (value: string): string => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const tau = Math.PI * 2;
const positiveAngle = (value: number): number => ((value % tau) + tau) % tau;
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const circumcenter = (a: Point, b: Point, c: Point): Point | undefined => {
  const determinant = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(determinant) < 1e-9) return undefined;
  return {
    x: ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / determinant,
    y: ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / determinant
  };
};

const arcCommand = (segment: ArcSegment): string => {
  const center = segment.center ?? (segment.via ? circumcenter(segment.start, segment.via, segment.end) : undefined);
  const radius = segment.radius ?? (center ? distance(segment.start, center) : distance(segment.start, segment.end) / 2);
  let clockwise = segment.clockwise ?? false;
  let largeArc = 0;
  if (center) {
    const start = Math.atan2(segment.start.y - center.y, segment.start.x - center.x);
    const end = Math.atan2(segment.end.y - center.y, segment.end.x - center.x);
    if (segment.via && segment.clockwise === undefined) {
      const via = Math.atan2(segment.via.y - center.y, segment.via.x - center.x);
      clockwise = positiveAngle(via - start) <= positiveAngle(end - start);
    }
    const sweep = clockwise ? positiveAngle(end - start) : positiveAngle(start - end);
    largeArc = sweep > Math.PI ? 1 : 0;
  }
  return `A ${radius} ${radius} 0 ${largeArc} ${clockwise ? 1 : 0} ${segment.end.x} ${segment.end.y}`;
};

const pathData = (operation: Operation): string | undefined => {
  if (operation.segments?.length) return [`M ${operation.segments[0]!.start.x} ${operation.segments[0]!.start.y}`, ...operation.segments.map(segment => segment.kind === "line" ? `L ${segment.end.x} ${segment.end.y}` : arcCommand(segment))].join(" ");
  if (operation.path?.length) return `M ${operation.path.map(point => `${point.x} ${point.y}`).join(" L ")}`;
  return undefined;
};

const pathStyle = (operation: Operation): { stroke: string; fill: string; dash?: string } => {
  if (operation.kind === "geometry") return { stroke: "#64748b", fill: "none", dash: "7 5" };
  if (operation.kind === "pocket") return { stroke: "#7c3aed", fill: "#8b5cf626" };
  if (operation.kind === "saw" || operation.kind === "cut") return { stroke: "#0891b2", fill: "none" };
  if (operation.kind === "groove") return { stroke: "#0f766e", fill: "none" };
  return { stroke: "#2563eb", fill: "none" };
};

export interface SvgRenderOptions {
  operationIds?: ReadonlySet<string>;
  highlightedOperationIds?: ReadonlySet<string>;
}

export function renderSvg(document: OpenCncDocument, options: SvgRenderOptions = {}): string {
  const width = document.panel.width ?? 1000;
  const height = document.panel.height ?? 600;
  const visibleOperations = document.operations.filter(operation => options.operationIds === undefined || options.operationIds.has(operation.id));
  const hasHighlight = visibleOperations.some(operation => options.highlightedOperationIds?.has(operation.id));
  const shapes = visibleOperations.flatMap(operation => {
    const title = esc([operation.id, operation.sourceType, operation.label, operation.depth !== undefined ? `depth ${operation.depth}` : undefined, operation.diameter !== undefined ? `diameter ${operation.diameter}` : undefined].filter(Boolean).join(" · "));
    const highlighted = options.highlightedOperationIds?.has(operation.id) ?? false;
    const line = typeof operation.raw.line === "number" ? ` data-source-line="${operation.raw.line}"` : "";
    const opening = `<g class="operation-shape operation-${operation.kind}${highlighted ? " operation-highlighted" : ""}" data-operation-id="${esc(operation.id)}"${line} role="button" tabindex="0" aria-label="${title}"><title>${title}</title>`;
    const renderedPath = pathData(operation);
    if (renderedPath) {
      const style = pathStyle(operation);
      return [`${opening}<path d="${renderedPath}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="${Math.max(1, operation.diameter ?? 2)}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""} stroke-linecap="round" stroke-linejoin="round" /></g>`];
    }
    if (operation.position) return [`${opening}${operationPoints(operation).map(position => `<circle cx="${position.x}" cy="${position.y}" r="${Math.max(1, (operation.diameter ?? 4) / 2)}" fill="${operation.face === undefined || operation.face === 0 ? "#dc2626" : "#f59e0b"}" fill-opacity="0.82" />`).join("")}</g>`];
    return [];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="opencnc-preview${hasHighlight ? " has-highlight" : ""}" viewBox="0 0 ${width} ${height}" role="img" aria-label="OpenCNC panel preview">\n  <rect width="${width}" height="${height}" fill="#f5deb3" stroke="#292524" stroke-width="2" />\n  ${shapes.join("\n  ")}\n</svg>\n`;
}
