import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";

const MAX_WIDTH = 1200;
const MAX_HEIGHT = 800;

const REMOVED_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
]);

/**
 * Pulls the SVG document out of a model response. Accepts raw `<svg>` blocks,
 * ```svg fenced blocks, and an optional leading XML declaration.
 */
export function extractSvg(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/```(?:svg|xml)?[ \t]*\r?\n?([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
  }
  text = text.replace(/^\s*<\?xml[^>]*\?>/i, "").trim();

  const start = text.search(/<svg(?=[\s/>])/i);
  if (start === -1) {
    return null;
  }

  let end = -1;
  const closingTag = /<\/svg\s*>/gi;
  for (let match = closingTag.exec(text); match; match = closingTag.exec(text)) {
    end = match.index + match[0].length;
  }

  return text.slice(start, end > start ? end : undefined).trim();
}

/**
 * Parses, validates, and sanitizes an SVG. The result is safe to embed: scripts,
 * event handlers, and external references have been removed.
 */
export function validateAndSanitizeSvg(
  raw: string,
): { ok: true; svg: string } | { ok: false; reason: string } {
  const extracted = extractSvg(raw);
  if (!extracted) {
    return { ok: false, reason: "No SVG found in response" };
  }

  const parseErrors: string[] = [];
  let document: Document;
  try {
    document = new DOMParser({
      onError(_level, message) {
        // For image/svg+xml, xmldom reports warnings for well-formedness
        // problems (e.g. unquoted attributes) that it may silently repair.
        parseErrors.push(message);
      },
    }).parseFromString(extracted, "image/svg+xml");
  } catch (error) {
    return {
      ok: false,
      reason: `Malformed SVG: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parseErrors.length > 0) {
    return { ok: false, reason: `Malformed SVG: ${parseErrors[0]}` };
  }

  const root = document.documentElement;
  if (!root || (root.localName || root.tagName).toLowerCase() !== "svg") {
    return { ok: false, reason: "SVG root element is missing" };
  }

  const viewBox = parseViewBox(root.getAttribute("viewBox"));
  if (!viewBox) {
    return { ok: false, reason: "SVG must have a valid viewBox" };
  }
  if (viewBox.width > MAX_WIDTH || viewBox.height > MAX_HEIGHT) {
    return {
      ok: false,
      reason: `SVG viewBox must not exceed ${MAX_WIDTH}x${MAX_HEIGHT}`,
    };
  }

  const width = parseLength(root.getAttribute("width"));
  const height = parseLength(root.getAttribute("height"));
  if (width !== null && width > MAX_WIDTH) {
    return { ok: false, reason: `SVG width must not exceed ${MAX_WIDTH}` };
  }
  if (height !== null && height > MAX_HEIGHT) {
    return { ok: false, reason: `SVG height must not exceed ${MAX_HEIGHT}` };
  }

  sanitize(document);

  return { ok: true, svg: new XMLSerializer().serializeToString(document) };
}

function parseViewBox(value: string | null): { width: number; height: number } | null {
  if (!value) {
    return null;
  }
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const width = parts[2];
  const height = parts[3];
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function parseLength(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitize(document: Document): void {
  const nodeList = document.getElementsByTagName("*");
  const elements: Element[] = [];
  for (let i = 0; i < nodeList.length; i++) {
    const element = nodeList.item(i);
    if (element) {
      elements.push(element);
    }
  }

  for (const element of elements) {
    const tagName = (element.localName || element.tagName).toLowerCase();
    if (REMOVED_ELEMENTS.has(tagName)) {
      element.parentNode?.removeChild(element);
      continue;
    }

    const attributes = Array.from({ length: element.attributes.length }, (_, i) =>
      element.attributes.item(i),
    );

    let removeImage = false;
    for (const attribute of attributes) {
      if (!attribute) {
        continue;
      }

      const name = attribute.name.toLowerCase();
      const value = attribute.value;

      if (name.startsWith("on")) {
        element.removeAttributeNode(attribute);
        continue;
      }

      if (name === "href" || name.endsWith(":href")) {
        if (!value.trim().startsWith("#")) {
          if (tagName === "image") {
            removeImage = true;
          }
          element.removeAttributeNode(attribute);
        }
        continue;
      }

      if (name === "style" && /url\(\s*['"]?https?:/i.test(value)) {
        element.removeAttributeNode(attribute);
      }
    }

    if (removeImage) {
      element.parentNode?.removeChild(element);
    }
  }
}
