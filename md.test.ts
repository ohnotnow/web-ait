import { test, expect } from "bun:test";

// md() lives inline in index.html (two-file architecture); lift it out by marker.
const html = await Bun.file(`${import.meta.dir}/index.html`).text();
const src = html.slice(html.indexOf("// md:start"), html.indexOf("// md:end"));
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md: (s: string) => string = new Function("esc", `${src}; return md;`)(esc);

test("renders the markdown subset ait descriptions use", () => {
  const out = md([
    "# Title",
    "Para with `code`, **bold** and [link](https://x.io).",
    "",
    "## Files",
    "- `a.php` - first",
    "  continues here",
    "- [ ] todo",
    "- [x] done",
    "1. one",
    "```",
    "<raw> & stuff",
    "```",
  ].join("\n"));
  expect(out).toContain("<h1>Title</h1>");
  expect(out).toContain('<p>Para with <code>code</code>, <strong>bold</strong> and <a href="https://x.io" target="_blank" rel="noopener">link</a>.</p>');
  expect(out).toContain("<h2>Files</h2>");
  expect(out).toContain("<ul><li><code>a.php</code> - first continues here</li>");
  expect(out).toContain('<li><input type="checkbox" disabled>todo</li>');
  expect(out).toContain('<li><input type="checkbox" disabled checked>done</li></ul>');
  expect(out).toContain("<ol><li>one</li></ol>");
  expect(out).toContain("<pre><code>&lt;raw&gt; &amp; stuff</code></pre>");
});

test("renders pipe tables", () => {
  const out = md("| Job | Today |\n|---|---|\n| `A` | x \\| y |\n| B | z |\n\nafter");
  expect(out).toContain("<table><thead><tr><th>Job</th><th>Today</th></tr></thead>");
  expect(out).toContain("<tbody><tr><td><code>A</code></td><td>x | y</td></tr><tr><td>B</td><td>z</td></tr></tbody></table>");
  expect(out).toContain("<p>after</p>");
});

test("escapes html outside code", () => {
  expect(md("<script>x</script>")).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
});

const depSrc = html.slice(html.indexOf("// deps:start"), html.indexOf("// deps:end"));
const { annotateDeps, openBlockers } = new Function(`${depSrc}; return { annotateDeps, openBlockers };`)();

test("annotates blockers and ignores finished ones", () => {
  const a = { id: "A", status: "open" }, b = { id: "B", status: "closed" }, c = { id: "C", status: "in_progress" }, d = { id: "D", status: "closed" };
  const issues: any[] = [a, b, c, d];
  annotateDeps(issues, [{ blocked: "A", blocker: "B" }, { blocked: "A", blocker: "C" }, { blocked: "D", blocker: "C" }, { blocked: "A", blocker: "GONE" }]);
  expect(openBlockers(a).map((i: any) => i.id)).toEqual(["C"]);
  expect((c as any)._blocks.map((i: any) => i.id)).toEqual(["A", "D"]);
  expect(openBlockers(d)).toEqual([]); // finished issues are never blocked
});
