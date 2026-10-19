import { describe, expect, it } from "vitest";
import { extractSvg, validateAndSanitizeSvg } from "./validate";
import { placeholderSvg } from "./placeholder";

it("extracts fenced SVG and strips an XML declaration", () => {
  const raw = '```svg\n<?xml version="1.0"?><svg viewBox="0 0 100 100"><circle cx="1" cy="1" r="1"/></svg>\n```';
  expect(extractSvg(raw)).toContain("<svg");
  expect(validateAndSanitizeSvg(raw).ok).toBe(true);
});

it("removes scripts, event handlers, and external references", () => {
  const raw = '<svg viewBox="0 0 100 100" onload="alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink"><script>alert(1)</script><image href="https://evil.test/a.png"/><use xlink:href="#ok"/></svg>';
  const result = validateAndSanitizeSvg(raw);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.svg).not.toContain("<script");
    expect(result.svg).not.toContain("onload");
    expect(result.svg).not.toContain("https://evil.test");
    expect(result.svg).toContain("#ok");
  }
});

it("rejects missing viewBox, oversized SVG, and malformed XML", () => {
  expect(validateAndSanitizeSvg("<svg width='100' height='100'></svg>").ok).toBe(false);
  expect(validateAndSanitizeSvg('<svg viewBox="0 0 2000 100"></svg>').ok).toBe(false);
  expect(validateAndSanitizeSvg("<svg viewBox='0 0 10 10'>").ok).toBe(false);
});

it("placeholder includes the escaped day title", () => {
  expect(placeholderSvg("Day 1 <山>")).toContain("Day 1 &lt;山&gt;");
});
