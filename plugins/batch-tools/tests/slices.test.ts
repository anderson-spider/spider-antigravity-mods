import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { createAuditLog } from "../server/audit.ts";
import { DEFAULT_INLINE_MAX_BYTES, utf8ByteLength } from "../server/budget.ts";
import { createPolicyGuard } from "../server/policy.ts";
import {
  runQuickOutline,
  runReadSlices,
  type SlicesRuntimeDeps,
} from "../server/slices.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(
  root: string,
  relPath: string,
  content: string | Buffer,
): Promise<string> {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

function makeDeps(root: string): {
  deps: SlicesRuntimeDeps;
  audit: ReturnType<typeof createAuditLog>;
} {
  const audit = createAuditLog();
  const policy = createPolicyGuard({
    mcpRoots: [root],
    audit,
  });
  return { deps: { policy, audit }, audit };
}

afterEach(async () => {
  mock.restoreAll();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("runQuickOutline", () => {
  it("extracts outlines across multiple languages (TS, Python, Go, Rust, Markdown)", async () => {
    const root = await makeTempDir("bt-slices-lang-");
    await writeFixture(
      root,
      "src/service.ts",
      [
        "export interface User {",
        "  id: string;",
        "}",
        "",
        "export class UserService {",
        "  getUser(id: string): User {",
        "    return { id };",
        "  }",
        "}",
        "",
        "export function helper(): number {",
        "  return 42;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "scripts/worker.py",
      [
        "class Worker:",
        "    def run(self):",
        "        return 1",
        "",
        "def start_all():",
        "    return Worker().run()",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "pkg/main.go",
      [
        "package main",
        "",
        "type Server struct {",
        "    Addr string",
        "}",
        "",
        "func (s *Server) Start() error {",
        "    return nil",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "crates/lib.rs",
      [
        "pub struct Engine {",
        "    pub speed: u32,",
        "}",
        "",
        "pub fn boot() -> Engine {",
        "    Engine { speed: 10 }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "docs/guide.md",
      [
        "# Architecture",
        "",
        "Intro text.",
        "",
        "## Security",
        "",
        "Details.",
        "",
      ].join("\n"),
    );

    const { deps, audit } = makeDeps(root);
    const res = await runQuickOutline(
      {
        paths: [
          "src/service.ts",
          "scripts/worker.py",
          "pkg/main.go",
          "crates/lib.rs",
          "docs/guide.md",
        ],
      },
      deps,
    );

    assert.equal(res.isError, false);
    assert.ok(utf8ByteLength(res.text) <= DEFAULT_INLINE_MAX_BYTES);

    assert.ok(res.text.includes("## Outline: src/service.ts (13 lines)"));
    assert.ok(res.text.includes("interface User [L1-L3]"));
    assert.ok(res.text.includes("class UserService [L5-L9]"));
    assert.ok(res.text.includes("  method getUser [L6-L8]"));
    assert.ok(res.text.includes("function helper [L11-L13]"));

    assert.ok(res.text.includes("## Outline: scripts/worker.py"));
    assert.ok(res.text.includes("class Worker"));
    assert.ok(res.text.includes("method run"));
    assert.ok(res.text.includes("function start_all"));

    assert.ok(res.text.includes("## Outline: pkg/main.go"));
    assert.ok(res.text.includes("struct Server"));
    assert.ok(res.text.includes("Start"));

    assert.ok(res.text.includes("## Outline: crates/lib.rs"));
    assert.ok(res.text.includes("struct Engine"));
    assert.ok(res.text.includes("fn boot [L5-L7]"));

    assert.ok(res.text.includes("## Outline: docs/guide.md"));
    assert.ok(res.text.includes("Architecture"));
    assert.ok(res.text.includes("Security"));

    const entries = audit.list();
    assert.ok(
      entries.some((e) => e.tool === "quick_outline" && e.status === "ok"),
    );
  });

  it("accepts JSON-stringified paths array and bare string path", async () => {
    const root = await makeTempDir("bt-slices-json-");
    await writeFixture(root, "a.ts", "export function alpha() { return 1; }\n");
    await writeFixture(root, "b.ts", "export function beta() { return 2; }\n");
    const { deps } = makeDeps(root);

    const resJson = await runQuickOutline(
      { paths: JSON.stringify(["a.ts", "b.ts"]) },
      deps,
    );
    assert.equal(resJson.isError, false);
    assert.ok(resJson.text.includes("function alpha"));
    assert.ok(resJson.text.includes("function beta"));

    const resBare = await runQuickOutline({ paths: "a.ts" }, deps);
    assert.equal(resBare.isError, false);
    assert.ok(resBare.text.includes("function alpha"));
  });

  it("enforces the 40-file cap and rejects empty or invalid paths", async () => {
    const root = await makeTempDir("bt-slices-cap-");
    const { deps, audit } = makeDeps(root);

    const fortyOne = Array.from({ length: 41 }, (_, i) => `file_${i}.ts`);
    const overRes = await runQuickOutline({ paths: fortyOne }, deps);
    assert.equal(overRes.isError, true);
    assert.ok(overRes.text.includes("max 40 paths"));

    const emptyRes = await runQuickOutline({ paths: [] }, deps);
    assert.equal(emptyRes.isError, true);
    assert.ok(emptyRes.text.includes("provide at least one file path"));

    const invalidRes = await runQuickOutline(
      { paths: ["ok.ts", "   "] },
      deps,
    );
    assert.equal(invalidRes.isError, true);

    assert.ok(
      audit.list().some((e) => e.tool === "quick_outline" && e.status === "error"),
    );
  });

  it("applies water-filling budget strictly <= 8,800 UTF-8 bytes and <= maxChars on huge and many files", async () => {
    const root = await makeTempDir("bt-slices-budget-");

    // 1 small file + 1 huge file with 250 classes + nested methods
    await writeFixture(
      root,
      "small.ts",
      "export function keepMeIntact(): string {\n  return 'ok';\n}\n",
    );

    const hugeLines: string[] = [];
    for (let i = 0; i < 200; i++) {
      hugeLines.push(`export class BigHandler_${i} {`);
      hugeLines.push(`  handleAlpha_${i}(): void {`);
      hugeLines.push(`    return;`);
      hugeLines.push(`  }`);
      hugeLines.push(`  handleBeta_${i}(): void {`);
      hugeLines.push(`    return;`);
      hugeLines.push(`  }`);
      hugeLines.push(`}`);
    }
    await writeFixture(root, "huge.ts", hugeLines.join("\n") + "\n");

    const { deps } = makeDeps(root);
    const res = await runQuickOutline({ paths: ["small.ts", "huge.ts"] }, deps);
    assert.equal(res.isError, false);
    assert.ok(
      utf8ByteLength(res.text) <= DEFAULT_INLINE_MAX_BYTES,
      `byte length ${utf8ByteLength(res.text)} exceeded ${DEFAULT_INLINE_MAX_BYTES}`,
    );
    assert.ok(res.text.length <= 8_500);
    // Small file must remain completely intact thanks to water-filling.
    assert.ok(res.text.includes("function keepMeIntact [L1-L3]"));
    assert.ok(res.text.includes("class BigHandler_0"));
    assert.ok(res.text.includes("omitted"));

    // 30 files with multi-byte UTF-8 names / comments
    const manyPaths: string[] = [];
    for (let i = 0; i < 30; i++) {
      const file = `many/mod_${i}.ts`;
      manyPaths.push(file);
      const body = Array.from(
        { length: 25 },
        (_, j) => `export function fn_${i}_${j}_日本語_${"é".repeat(4)}() {\n  return ${j};\n}`,
      ).join("\n");
      await writeFixture(root, file, body + "\n");
    }

    const resMany = await runQuickOutline({ paths: manyPaths }, deps);
    assert.equal(resMany.isError, false);
    assert.ok(
      utf8ByteLength(resMany.text) <= DEFAULT_INLINE_MAX_BYTES,
      `many-files bytes ${utf8ByteLength(resMany.text)} exceeded ${DEFAULT_INLINE_MAX_BYTES}`,
    );
    assert.ok(resMany.text.length <= 8_500);
    assert.ok(resMany.text.includes("batch 10-20 files per call"));

    // Clamps maxChars to [500, DEFAULT_INLINE_MAX_BYTES]
    const resTight = await runQuickOutline(
      { paths: ["small.ts", "huge.ts"], maxChars: 100 },
      deps,
    );
    assert.equal(resTight.isError, false);
    assert.ok(resTight.text.length <= 500);
    assert.ok(utf8ByteLength(resTight.text) <= DEFAULT_INLINE_MAX_BYTES);
  });
});

describe("runReadSlices", () => {
  it("combines outlines, slice objects, slice shorthand, and lineRanges with formatted line numbers", async () => {
    const root = await makeTempDir("bt-slices-combo-");
    const appLines = Array.from(
      { length: 30 },
      (_, idx) => `export const line_${idx + 1} = ${idx + 1};`,
    );
    appLines[0] = "export function bootApp(): number {";
    appLines[1] = "  return 1;";
    appLines[2] = "}";
    await writeFixture(root, "src/app.ts", appLines.join("\n") + "\n");
    await writeFixture(
      root,
      "src/util.ts",
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "export function sub(a: number, b: number): number {",
        "  return a - b;",
        "}",
        "",
      ].join("\n"),
    );

    const { deps } = makeDeps(root);
    const res = await runReadSlices(
      {
        outlines: ["src/app.ts"],
        slices: [
          { path: "src/app.ts", ranges: [[1, 3]] },
          "src/util.ts:4-6",
        ],
        lineRanges: ["src/app.ts:9-11,29-30", "src/util.ts:2"],
      },
      deps,
    );

    assert.equal(res.isError, false);
    assert.ok(utf8ByteLength(res.text) <= DEFAULT_INLINE_MAX_BYTES);
    assert.ok(res.text.includes("## Outline: src/app.ts (30 lines)"));
    assert.ok(res.text.includes("function bootApp [L1-L3]"));
    assert.ok(res.text.includes("## Slice: src/app.ts (30 lines)"));
    assert.ok(res.text.includes("--- L1-L3 (of 30) ---"));
    assert.ok(res.text.includes("1: export function bootApp(): number {"));
    assert.ok(res.text.includes("--- L9-L11 (of 30) ---"));
    assert.ok(res.text.includes(" 9: export const line_9 = 9;"));
    assert.ok(res.text.includes("11: export const line_11 = 11;"));
    assert.ok(res.text.includes("--- L29-L30 (of 30) ---"));
    assert.ok(res.text.includes("--- L4-L6 (of 6) ---"));
    assert.ok(res.text.includes("--- L2-L2 (of 6) ---"));
    assert.ok(res.text.includes("2:   return a + b;"));
  });

  it("accepts JSON-stringified inputs for outlines, slices, and lineRanges", async () => {
    const root = await makeTempDir("bt-slices-json-in-");
    await writeFixture(
      root,
      "src/mod.ts",
      ["export function one() {", "  return 1;", "}", "export function two() {", "  return 2;", "}", ""].join("\n"),
    );

    const { deps } = makeDeps(root);
    const res = await runReadSlices(
      {
        outlines: JSON.stringify(["src/mod.ts"]),
        slices: JSON.stringify([{ path: "src/mod.ts", ranges: [[1, 3]] }]),
        lineRanges: JSON.stringify(["src/mod.ts:4-6"]),
      },
      deps,
    );

    assert.equal(res.isError, false);
    assert.ok(res.text.includes("## Outline: src/mod.ts (6 lines)"));
    assert.ok(res.text.includes("--- L1-L3 (of 6) ---"));
    assert.ok(res.text.includes("--- L4-L6 (of 6) ---"));
  });

  it("deduplicates concurrent file reads per call via canonicalPath cache", async () => {
    const root = await makeTempDir("bt-slices-cache-");
    await writeFixture(
      root,
      "src/shared.ts",
      [
        "export function alpha() {",
        "  return 'a';",
        "}",
        "export function beta() {",
        "  return 'b';",
        "}",
        "",
      ].join("\n"),
    );

    const { deps } = makeDeps(root);
    const readSpy = mock.method(fs, "readFile");

    const res1 = await runReadSlices(
      {
        outlines: ["src/shared.ts"],
        slices: [{ path: "./src/shared.ts", ranges: [[1, 3]] }],
        lineRanges: ["src/../src/shared.ts:4-6"],
      },
      deps,
    );

    assert.equal(res1.isError, false);
    assert.equal(readSpy.mock.callCount(), 1);

    // Separate call gets a fresh per-call cache and reads again.
    const res2 = await runReadSlices({ lineRanges: ["src/shared.ts:1-2"] }, deps);
    assert.equal(res2.isError, false);
    assert.equal(readSpy.mock.callCount(), 2);
  });

  it("handles out-of-bounds, inverted, clamped, and empty-file ranges gracefully", async () => {
    const root = await makeTempDir("bt-slices-ranges-");
    await writeFixture(root, "notes.txt", "first\nsecond\nthird\n");
    await writeFixture(root, "empty.txt", "");

    const { deps } = makeDeps(root);
    const res = await runReadSlices(
      {
        slices: [
          {
            path: "notes.txt",
            ranges: [
              [0, 2],
              [2, 50],
              [10, 20],
              [3, 1],
              [Number.NaN, 2],
            ],
          },
          {
            path: "empty.txt",
            ranges: [[1, 5]],
          },
        ],
      },
      deps,
    );

    assert.equal(res.isError, false);
    assert.ok(res.text.includes("--- L1-L2 (of 3) ---"));
    assert.ok(res.text.includes("--- L2-L3 (of 3) ---"));
    assert.ok(res.text.includes("--- L10-L20 (out of bounds; file has 3 lines) ---"));
    assert.ok(res.text.includes("ERROR: startLine (3) > endLine (1)"));
    assert.ok(res.text.includes("ERROR: invalid range [NaN, 2]"));
    assert.ok(res.text.includes("--- L1-L5 (out of bounds; file has 0 lines) ---"));
  });

  it("handles binary files gracefully and caps huge slice output <= 8,800 UTF-8 bytes", async () => {
    const root = await makeTempDir("bt-slices-binary-");
    await writeFixture(root, "data.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const bigText = Array.from(
      { length: 400 },
      (_, i) => `line_${i + 1}: ${"x".repeat(60)}`,
    ).join("\n");
    await writeFixture(root, "big.txt", bigText + "\n");

    const { deps } = makeDeps(root);

    // Binary file alone -> isError: true
    const binOnly = await runReadSlices({ lineRanges: ["data.bin:1-5"] }, deps);
    assert.equal(binOnly.isError, true);
    assert.ok(binOnly.text.includes("Binary file cannot be read as text"));

    // Binary mixed with huge text file -> isError: false, inline binary error, byte-capped output
    const mixed = await runReadSlices(
      { lineRanges: ["data.bin:1-5", "big.txt:1-400"] },
      deps,
    );
    assert.equal(mixed.isError, false);
    assert.ok(mixed.text.includes("Binary file cannot be read as text"));
    assert.ok(utf8ByteLength(mixed.text) <= DEFAULT_INLINE_MAX_BYTES);
    assert.ok(mixed.text.length <= 8_500);
  });

  it("supports cwd subdirectory resolution and enforces slice limits", async () => {
    const root = await makeTempDir("bt-slices-cwd-");
    await writeFixture(root, "packages/api/index.ts", "export const ok = true;\n");
    const { deps } = makeDeps(root);

    const res = await runReadSlices(
      { cwd: "packages/api", lineRanges: ["index.ts:1-1"] },
      deps,
    );
    assert.equal(res.isError, false);
    assert.ok(res.text.includes("## Slice: index.ts (1 lines)"));
    assert.ok(res.text.includes("1: export const ok = true;"));

    const tooManySlices = Array.from({ length: 31 }, (_, i) => `f_${i}.ts:1-2`);
    const overRes = await runReadSlices({ lineRanges: tooManySlices }, deps);
    assert.equal(overRes.isError, true);
    assert.ok(overRes.text.includes("limits exceeded"));
  });
});

describe("security policy, audit, and redaction", () => {
  it("blocks .env while allowing .env.example in both quick_outline and read_slices", async () => {
    const root = await makeTempDir("bt-slices-env-");
    await writeFixture(root, ".env", "API_SECRET=super_top_secret_value\n");
    await writeFixture(root, ".env.local", "DB_PASS=hidden_local_secret\n");
    await writeFixture(root, ".env.example", "API_SECRET=changeme\nPORT=3000\n");

    const { deps, audit } = makeDeps(root);

    const envSlice = await runReadSlices({ lineRanges: [".env:1-5"] }, deps);
    assert.equal(envSlice.isError, true);
    assert.ok(envSlice.text.includes("Access denied"));
    assert.ok(!envSlice.text.includes("super_top_secret_value"));

    const envOutline = await runQuickOutline({ paths: [".env"] }, deps);
    assert.equal(envOutline.isError, true);
    assert.ok(envOutline.text.includes("Access denied"));
    assert.ok(!envOutline.text.includes("super_top_secret_value"));

    // Mixed call: .env.example succeeds, .env.local blocked without leaking contents
    const mixed = await runReadSlices(
      { lineRanges: [".env.example:1-2", ".env.local:1-2"] },
      deps,
    );
    assert.equal(mixed.isError, false);
    assert.ok(mixed.text.includes("API_SECRET=changeme"));
    assert.ok(mixed.text.includes("PORT=3000"));
    assert.ok(mixed.text.includes("Access denied"));
    assert.ok(!mixed.text.includes("hidden_local_secret"));

    const exampleOutline = await runQuickOutline({ paths: [".env.example"] }, deps);
    assert.equal(exampleOutline.isError, false);
    assert.ok(exampleOutline.text.includes("## Outline: .env.example"));

    assert.ok(
      audit.list().some((e) => e.tool === "read_slices" && e.status === "blocked"),
    );
    assert.ok(
      audit.list().some((e) => e.tool === "quick_outline" && e.status === "blocked"),
    );
  });

  it("blocks tilde (~) paths and .. traversal in both paths and cwd", async () => {
    const parent = await makeTempDir("bt-slices-trav-");
    const root = path.join(parent, "workspace");
    await fs.mkdir(root, { recursive: true });
    await writeFixture(parent, "outside.txt", "OUTSIDE_SECRET_DATA\n");
    await writeFixture(root, "inside.ts", "export const x = 1;\n");

    const { deps } = makeDeps(root);

    const tildeOutline = await runQuickOutline({ paths: ["~/.ssh/id_rsa"] }, deps);
    assert.equal(tildeOutline.isError, true);
    assert.ok(tildeOutline.text.includes("Access denied"));

    const tildeSlice = await runReadSlices({ lineRanges: ["~/secret.txt:1-5"] }, deps);
    assert.equal(tildeSlice.isError, true);
    assert.ok(tildeSlice.text.includes("Access denied"));

    const tildeCwd = await runReadSlices({ cwd: "~", lineRanges: ["inside.ts:1-1"] }, deps);
    assert.equal(tildeCwd.isError, true);
    assert.ok(tildeCwd.text.includes("Access denied"));

    const travOutline = await runQuickOutline({ paths: ["../outside.txt"] }, deps);
    assert.equal(travOutline.isError, true);
    assert.ok(travOutline.text.includes("Access denied"));
    assert.ok(!travOutline.text.includes("OUTSIDE_SECRET_DATA"));

    const travSlice = await runReadSlices({ lineRanges: ["../outside.txt:1-5"] }, deps);
    assert.equal(travSlice.isError, true);
    assert.ok(travSlice.text.includes("Access denied"));
    assert.ok(!travSlice.text.includes("OUTSIDE_SECRET_DATA"));

    const travCwd = await runQuickOutline({ cwd: "..", paths: ["outside.txt"] }, deps);
    assert.equal(travCwd.isError, true);
    assert.ok(travCwd.text.includes("Access denied"));
    assert.ok(!travCwd.text.includes("OUTSIDE_SECRET_DATA"));
  });

  it("blocks symlinks escaping workspace or pointing to secrets while allowing safe internal symlinks", async () => {
    const parent = await makeTempDir("bt-slices-sym-");
    const root = path.join(parent, "workspace");
    await fs.mkdir(root, { recursive: true });

    const externalFile = await writeFixture(parent, "external.ts", "export function leaked() {}\n");
    const internalFile = await writeFixture(root, "real.ts", "export function safeFn() { return 1; }\n");
    const secretFile = await writeFixture(root, ".env", "SECRET=do_not_expose\n");

    await fs.symlink(externalFile, path.join(root, "escape-link.ts"));
    await fs.symlink(internalFile, path.join(root, "safe-link.ts"));
    await fs.symlink(secretFile, path.join(root, "innocent-name.txt"));

    const { deps } = makeDeps(root);

    const escapeOutline = await runQuickOutline({ paths: ["escape-link.ts"] }, deps);
    assert.equal(escapeOutline.isError, true);
    assert.ok(escapeOutline.text.includes("Access denied"));
    assert.ok(!escapeOutline.text.includes("leaked"));

    const escapeSlice = await runReadSlices({ lineRanges: ["escape-link.ts:1-5"] }, deps);
    assert.equal(escapeSlice.isError, true);
    assert.ok(escapeSlice.text.includes("Access denied"));
    assert.ok(!escapeSlice.text.includes("leaked"));

    const secretLinkSlice = await runReadSlices(
      { lineRanges: ["innocent-name.txt:1-5"] },
      deps,
    );
    assert.equal(secretLinkSlice.isError, true);
    assert.ok(secretLinkSlice.text.includes("Access denied"));
    assert.ok(!secretLinkSlice.text.includes("do_not_expose"));

    const safeLinkSlice = await runReadSlices({ lineRanges: ["safe-link.ts:1-1"] }, deps);
    assert.equal(safeLinkSlice.isError, false);
    assert.ok(safeLinkSlice.text.includes("export function safeFn()"));
  });

  it("redacts credential patterns from error messages and audit entries", async () => {
    const root = await makeTempDir("bt-slices-redact-");
    const { deps, audit } = makeDeps(root);

    const missingPath = "missing/glpat-SecretTokenValue12345/app.ts";
    const res = await runReadSlices({ lineRanges: [`${missingPath}:1-5`] }, deps);
    assert.equal(res.isError, true);
    assert.ok(!res.text.includes("SecretTokenValue12345"));
    assert.ok(res.text.includes("glpat-***"));

    const invalidRes = await runReadSlices(
      { lineRanges: ["bad-glpat-AnotherSecret99999"] },
      deps,
    );
    assert.equal(invalidRes.isError, true);
    assert.ok(!invalidRes.text.includes("AnotherSecret99999"));
    assert.ok(invalidRes.text.includes("glpat-***"));

    for (const entry of audit.list()) {
      assert.ok(!(entry.summary ?? "").includes("SecretTokenValue12345"));
      assert.ok(!(entry.summary ?? "").includes("AnotherSecret99999"));
    }
  });
});
