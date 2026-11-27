import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectLanguage,
  extractSymbols,
  extractSymbolsFromLines,
  formatSymbolLine,
  type SymbolEntry,
} from "../server/outline.ts";

describe("formatSymbolLine & detectLanguage", () => {
  it("formats single-line, multi-line, and indented symbol lines compactly", () => {
    assert.equal(
      formatSymbolLine({
        kind: "fn",
        name: "foo",
        startLine: 12,
        endLine: 40,
        depth: 1,
      }),
      "  fn foo [L12-L40]",
    );
    assert.equal(
      formatSymbolLine({
        kind: "package",
        name: "main",
        startLine: 1,
        endLine: 1,
        depth: 0,
      }),
      "package main [L1]",
    );
    assert.equal(
      formatSymbolLine({
        kind: "method",
        name: "nested",
        startLine: 10,
        endLine: 15,
        depth: 2,
      }),
      "    method nested [L10-L15]",
    );
    assert.equal(
      formatSymbolLine({
        kind: "key",
        name: "clamped",
        startLine: 3,
        endLine: 3,
        depth: -2,
      }),
      "key clamped [L3]",
    );
  });

  it("detects languages by extension and shebang fallback", () => {
    assert.equal(detectLanguage("src/app.tsx"), "tsjs");
    assert.equal(detectLanguage("script.mjs"), "tsjs");
    assert.equal(detectLanguage("main.pyi"), "python");
    assert.equal(detectLanguage("cmd/server.go"), "go");
    assert.equal(detectLanguage("src/lib.rs"), "rust");
    assert.equal(detectLanguage("src/App.kt"), "clike");
    assert.equal(detectLanguage("src/View.swift"), "clike");
    assert.equal(detectLanguage("index.html"), "html");
    assert.equal(detectLanguage("App.vue"), "vue");
    assert.equal(detectLanguage("App.svelte"), "svelte");
    assert.equal(detectLanguage("styles.scss"), "css");
    assert.equal(detectLanguage("deploy.zsh"), "shell");
    assert.equal(detectLanguage("README.mdx"), "markdown");
    assert.equal(detectLanguage("config.jsonc"), "json");
    assert.equal(detectLanguage("ci.yml"), "yaml");
    assert.equal(detectLanguage("bin/deploy", "#!/usr/bin/env bash"), "shell");
    assert.equal(detectLanguage("bin/tool", "#!/usr/bin/env python3"), "python");
    assert.equal(detectLanguage("notes.txt"), "unknown");
  });
});

describe("TypeScript / JavaScript / TSX / JSX", () => {
  it("extracts functions, classes, methods, interfaces, types, enums, exported const arrows/objects, routes, and tests", () => {
    const code = [
      "export interface User {", // 1
      "  id: string;", // 2
      "}", // 3
      "", // 4
      "export type UserRole =", // 5
      "  | 'admin'", // 6
      "  | 'member'", // 7
      "", // 8
      "export enum Status {", // 9
      "  Active = 'active',", // 10
      "}", // 11
      "", // 12
      "export class UserService {", // 13
      "  async findById<T>(id: string): Promise<T | null> {", // 14
      "    if (id.length === 0) {", // 15
      "      return null;", // 16
      "    }", // 17
      "    return null;", // 18
      "  }", // 19
      "", // 20
      "  private format(u: User) {", // 21
      "    return u.id;", // 22
      "  }", // 23
      "}", // 24
      "", // 25
      "export async function createUser(name: string) {", // 26
      "  return { name };", // 27
      "}", // 28
      "", // 29
      "export const normalize = (", // 30
      "  input: string,", // 31
      ") => {", // 32
      "  return input.trim();", // 33
      "};", // 34
      "", // 35
      "export const handlers = {", // 36
      "  ping: () => 'pong',", // 37
      "};", // 38
      "", // 39
      "export function registerRoutes(app: any) {", // 40
      "  app.get('/users', async (req: any, res: any) => {", // 41
      "    res.send([]);", // 42
      "  });", // 43
      "  app.post('/users', (req: any, res: any) => res.send({ ok: true }));", // 44
      "}", // 45
      "", // 46
      "router.delete('/users/:id', (req: any, res: any) => {", // 47
      "  res.status(204).end();", // 48
      "});", // 49
    ].join("\n");

    const symbols = extractSymbols("server/users.ts", code);
    assert.deepEqual(symbols, [
      { kind: "interface", name: "User", startLine: 1, endLine: 3, depth: 0 },
      { kind: "type", name: "UserRole", startLine: 5, endLine: 7, depth: 0 },
      { kind: "enum", name: "Status", startLine: 9, endLine: 11, depth: 0 },
      { kind: "class", name: "UserService", startLine: 13, endLine: 24, depth: 0 },
      { kind: "method", name: "findById", startLine: 14, endLine: 19, depth: 1 },
      { kind: "method", name: "format", startLine: 21, endLine: 23, depth: 1 },
      { kind: "function", name: "createUser", startLine: 26, endLine: 28, depth: 0 },
      { kind: "function", name: "normalize", startLine: 30, endLine: 34, depth: 0 },
      { kind: "const", name: "handlers", startLine: 36, endLine: 38, depth: 0 },
      { kind: "function", name: "registerRoutes", startLine: 40, endLine: 45, depth: 0 },
      { kind: "route", name: "GET /users", startLine: 41, endLine: 43, depth: 1 },
      { kind: "route", name: "POST /users", startLine: 44, endLine: 44, depth: 1 },
      { kind: "route", name: "DELETE /users/:id", startLine: 47, endLine: 49, depth: 0 },
    ] satisfies SymbolEntry[]);
  });

  it("extracts describe/it/test suites and nested cases", () => {
    const code = [
      "describe('auth', () => {", // 1
      "  it('logs in', () => {", // 2
      "    expect(true).toBe(true);", // 3
      "  });", // 4
      "  describe.skip('tokens', () => {", // 5
      "    test.only('refreshes', () => {", // 6
      "      expect(1).toBe(1);", // 7
      "    });", // 8
      "  });", // 9
      "});", // 10
      "test('standalone', () => {", // 11
      "  expect(2).toBe(2);", // 12
      "});", // 13
    ].join("\n");

    const symbols = extractSymbols("auth.test.mjs", code);
    assert.deepEqual(symbols, [
      { kind: "suite", name: "auth", startLine: 1, endLine: 10, depth: 0 },
      { kind: "test", name: "logs in", startLine: 2, endLine: 4, depth: 1 },
      { kind: "suite", name: "tokens", startLine: 5, endLine: 9, depth: 1 },
      { kind: "test", name: "refreshes", startLine: 6, endLine: 8, depth: 2 },
      { kind: "test", name: "standalone", startLine: 11, endLine: 13, depth: 0 },
    ]);
  });

  it("handles JSX />, template strings with ${...}, regex literals with {, and comments with braces", () => {
    const code = [
      "/* block comment with { and fake decl", // 1
      "export function fakeInComment() {}", // 2
      "*/", // 3
      "export function Card({ title }: { title: string }): Promise<{ ok: boolean }>", // 4
      "{", // 5
      "  // single-line comment with {{{", // 6
      "  const re1 = /\\{foo\\}[/]{1,3}/g;", // 7
      "  const re2 = />/g;", // 8
      "  const tpl = `hello ${ { nested: `inner {` }.nested } world", // 9
      "export function fakeInTemplate() {}", // 10
      "  `;", // 11
      "  const ratio = 10 / 2 / 5;", // 12
      "  const el = (", // 13
      "    <div>", // 14
      "      <Icon size={16} />", // 15
      "      <Badge", // 16
      "        label={title}", // 17
      "      />", // 18
      "      <span>{tpl}</span>", // 19
      "    </div>", // 20
      "  );", // 21
      "  if (re1.test(title) && re2.test('>') && ratio > 0) {", // 22
      "    return Promise.resolve({ ok: Boolean(el) });", // 23
      "  }", // 24
      "  return Promise.resolve({ ok: false });", // 25
      "}", // 26
      "", // 27
      "export const afterCard = () => {", // 28
      "  return /\\{end\\}/.test('{end}');", // 29
      "};", // 30
    ].join("\n");

    const symbols = extractSymbols("Card.tsx", code);
    assert.deepEqual(symbols, [
      { kind: "function", name: "Card", startLine: 4, endLine: 26, depth: 0 },
      { kind: "function", name: "afterCard", startLine: 28, endLine: 30, depth: 0 },
    ]);
  });
});

describe("Python", () => {
  it("handles decorators, indentation nesting, docstrings, async def, and multiline signatures", () => {
    const code = [
      "@dataclass", // 1
      "class Service:", // 2
      '    """', // 3
      "    def fake_in_docstring():", // 4
      "        pass", // 5
      '    """', // 6
      "", // 7
      "    @staticmethod", // 8
      "    async def fetch(", // 9
      "        url: str,", // 10
      "        timeout: int = 5,", // 11
      "    ) -> str:", // 12
      "        def helper(x: int) -> int:", // 13
      "            return x + 1", // 14
      "        msg = f'{helper(1):>4}'", // 15
      "        return msg", // 16
      "", // 17
      "# top-level comment", // 18
      "def run():", // 19
      "    return Service.fetch('https://example.com')", // 20
    ].join("\n");

    const symbols = extractSymbols("service.py", code);
    assert.deepEqual(symbols, [
      { kind: "class", name: "Service", startLine: 1, endLine: 16, depth: 0 },
      { kind: "method", name: "fetch", startLine: 8, endLine: 16, depth: 1 },
      { kind: "function", name: "helper", startLine: 13, endLine: 14, depth: 2 },
      { kind: "function", name: "run", startLine: 19, endLine: 20, depth: 0 },
    ]);
  });
});

describe("Go", () => {
  it("extracts package, structs, interfaces, type aliases, functions, and methods while ignoring raw strings", () => {
    const code = [
      "package server", // 1
      "", // 2
      "type Store interface {", // 3
      "    Get(key string) (string, error)", // 4
      "}", // 5
      "", // 6
      "type Cache[T any] struct {", // 7
      "    items map[string]T", // 8
      "}", // 9
      "", // 10
      "type Key = string", // 11
      "", // 12
      "func (c *Cache[T]) Get(k string) (T, bool) {", // 13
      "    raw := `", // 14
      "func FakeInRawString() {}", // 15
      "    }`", // 16
      "    _ = raw", // 17
      "    v, ok := c.items[k]", // 18
      "    return v, ok", // 19
      "}", // 20
      "", // 21
      "func NewCache[T any]() *Cache[T] {", // 22
      "    return &Cache[T]{}", // 23
      "}", // 24
    ].join("\n");

    const symbols = extractSymbols("cache.go", code);
    assert.deepEqual(symbols, [
      { kind: "package", name: "server", startLine: 1, endLine: 1, depth: 0 },
      { kind: "interface", name: "Store", startLine: 3, endLine: 5, depth: 0 },
      { kind: "struct", name: "Cache[T any]", startLine: 7, endLine: 9, depth: 0 },
      { kind: "type", name: "Key", startLine: 11, endLine: 11, depth: 0 },
      {
        kind: "method",
        name: "(c *Cache[T]) Get",
        startLine: 13,
        endLine: 20,
        depth: 0,
      },
      { kind: "function", name: "NewCache[T any]", startLine: 22, endLine: 24, depth: 0 },
    ]);
  });
});

describe("Rust", () => {
  it("extracts mod, struct, enum, trait, impl, fn, pub fn, and macro_rules with lifetimes and raw strings", () => {
    const code = [
      "mod external;", // 1
      "", // 2
      "pub struct Parser<'a> {", // 3
      "    src: &'a str,", // 4
      "}", // 5
      "", // 6
      "pub enum Token {", // 7
      "    Open,", // 8
      "    Close,", // 9
      "}", // 10
      "", // 11
      "pub trait Lexer<'a> {", // 12
      "    fn next_token(&mut self) -> Option<Token>;", // 13
      "}", // 14
      "", // 15
      "impl<'a> Parser<'a> {", // 16
      "    pub fn parse(&self) -> &'a str {", // 17
      "        let open = '{';", // 18
      '        let raw = r#"', // 19
      "fn fake_in_raw() {", // 20
      '"#;', // 21
      "        /* nested /* comment { */ */", // 22
      "        let _ = (open, raw);", // 23
      "        self.src", // 24
      "    }", // 25
      "}", // 26
      "", // 27
      "macro_rules! make_vec {", // 28
      "    ($($x:expr),*) => {", // 29
      "        vec![$($x),*]", // 30
      "    };", // 31
      "}", // 32
    ].join("\n");

    const symbols = extractSymbols("parser.rs", code);
    assert.deepEqual(symbols, [
      { kind: "mod", name: "external", startLine: 1, endLine: 1, depth: 0 },
      { kind: "struct", name: "Parser<'a>", startLine: 3, endLine: 5, depth: 0 },
      { kind: "enum", name: "Token", startLine: 7, endLine: 10, depth: 0 },
      { kind: "trait", name: "Lexer<'a>", startLine: 12, endLine: 14, depth: 0 },
      { kind: "fn", name: "next_token", startLine: 13, endLine: 13, depth: 1 },
      { kind: "impl", name: "<'a> Parser<'a>", startLine: 16, endLine: 26, depth: 0 },
      { kind: "fn", name: "parse", startLine: 17, endLine: 25, depth: 1 },
      { kind: "macro", name: "make_vec", startLine: 28, endLine: 32, depth: 0 },
    ]);
  });
});

describe("C / C++ / Java / Kotlin / C# / Swift", () => {
  it("extracts C++ namespace, class, methods, and free functions with default params", () => {
    const code = [
      "namespace engine {", // 1
      "  class Renderer {", // 2
      "    void draw(int scale = 1) {", // 3
      "      if (scale > 0) {}", // 4
      "    }", // 5
      "  };", // 6
      "}", // 7
      "", // 8
      "int main(int argc, char** argv) {", // 9
      "  return 0;", // 10
      "}", // 11
    ].join("\n");

    const symbols = extractSymbols("renderer.cpp", code);
    assert.deepEqual(symbols, [
      { kind: "namespace", name: "engine", startLine: 1, endLine: 7, depth: 0 },
      { kind: "class", name: "Renderer", startLine: 2, endLine: 6, depth: 1 },
      { kind: "method", name: "draw", startLine: 3, endLine: 5, depth: 2 },
      { kind: "function", name: "main", startLine: 9, endLine: 11, depth: 0 },
    ]);
  });

  it("extracts Java package, record, class, constructor, and methods", () => {
    const code = [
      "package com.example.app;", // 1
      "", // 2
      "public record Point(int x, int y) {}", // 3
      "", // 4
      "public class Greeter {", // 5
      "  public Greeter(String prefix) {", // 6
      "    this.prefix = prefix;", // 7
      "  }", // 8
      "  public String greet(String name) {", // 9
      "    return name;", // 10
      "  }", // 11
      "}", // 12
    ].join("\n");

    const symbols = extractSymbols("Greeter.java", code);
    assert.deepEqual(symbols, [
      { kind: "package", name: "com.example.app", startLine: 1, endLine: 1, depth: 0 },
      { kind: "record", name: "Point", startLine: 3, endLine: 3, depth: 0 },
      { kind: "class", name: "Greeter", startLine: 5, endLine: 12, depth: 0 },
      { kind: "method", name: "Greeter", startLine: 6, endLine: 8, depth: 1 },
      { kind: "method", name: "greet", startLine: 9, endLine: 11, depth: 1 },
    ]);
  });

  it("extracts Kotlin data class without braces, object, and suspend fun", () => {
    const code = [
      "package com.example.kt", // 1
      "", // 2
      "data class User(val id: Int)", // 3
      "", // 4
      "fun double(x: Int) = x * 2", // 5
      "", // 6
      "object Api {", // 7
      "  suspend fun load(id: Int): User {", // 8
      "    return User(id)", // 9
      "  }", // 10
      "}", // 11
    ].join("\n");

    const symbols = extractSymbols("Api.kt", code);
    assert.deepEqual(symbols, [
      { kind: "package", name: "com.example.kt", startLine: 1, endLine: 1, depth: 0 },
      { kind: "class", name: "User", startLine: 3, endLine: 3, depth: 0 },
      { kind: "function", name: "double", startLine: 5, endLine: 5, depth: 0 },
      { kind: "object", name: "Api", startLine: 7, endLine: 11, depth: 0 },
      { kind: "method", name: "load", startLine: 8, endLine: 10, depth: 1 },
    ]);
  });

  it("extracts C# file-scoped namespace and Swift protocol/struct/func", () => {
    const cs = [
      "namespace Acme.Billing;", // 1
      "public class Invoice {", // 2
      "  public decimal Total() {", // 3
      "    return 0m;", // 4
      "  }", // 5
      "}", // 6
    ].join("\n");

    assert.deepEqual(extractSymbols("Invoice.cs", cs), [
      { kind: "namespace", name: "Acme.Billing", startLine: 1, endLine: 1, depth: 0 },
      { kind: "class", name: "Invoice", startLine: 2, endLine: 6, depth: 0 },
      { kind: "method", name: "Total", startLine: 3, endLine: 5, depth: 1 },
    ]);

    const swift = [
      "protocol Renderable {", // 1
      "  func render()", // 2
      "}", // 3
      "struct Card: Renderable {", // 4
      "  func render() {", // 5
      "    print(\"card\")", // 6
      "  }", // 7
      "}", // 8
    ].join("\n");

    assert.deepEqual(extractSymbols("Card.swift", swift), [
      { kind: "protocol", name: "Renderable", startLine: 1, endLine: 3, depth: 0 },
      { kind: "method", name: "render", startLine: 2, endLine: 2, depth: 1 },
      { kind: "struct", name: "Card", startLine: 4, endLine: 8, depth: 0 },
      { kind: "method", name: "render", startLine: 5, endLine: 7, depth: 1 },
    ]);
  });
});

describe("HTML / Vue / Svelte", () => {
  it("extracts HTML landmarks, headings, components, and nested script/style symbols", () => {
    const html = [
      "<!doctype html>", // 1
      "<html>", // 2
      "  <body>", // 3
      "    <!-- Hero Section -->", // 4
      "    <main id=\"app\">", // 5
      "      <h1>Dashboard</h1>", // 6
      "      <textarea><section>ignored</section></textarea>", // 7
      "      <UserCard />", // 8
      "    </main>", // 9
      "    <script>", // 10
      "      function initApp() {", // 11
      "        return true;", // 12
      "      }", // 13
      "    </script>", // 14
      "    <style>", // 15
      "      .card {", // 16
      "        color: red;", // 17
      "      }", // 18
      "    </style>", // 19
      "  </body>", // 20
      "</html>", // 21
    ].join("\n");

    const symbols = extractSymbols("index.html", html);
    assert.deepEqual(symbols, [
      { kind: "block", name: "<body>", startLine: 3, endLine: 20, depth: 0 },
      { kind: "section", name: "Hero Section", startLine: 4, endLine: 4, depth: 1 },
      { kind: "block", name: "<main #app>", startLine: 5, endLine: 9, depth: 1 },
      { kind: "h1", name: "Dashboard", startLine: 6, endLine: 6, depth: 2 },
      { kind: "component", name: "<UserCard>", startLine: 8, endLine: 8, depth: 2 },
      { kind: "script", name: "<script>", startLine: 10, endLine: 14, depth: 1 },
      { kind: "function", name: "initApp", startLine: 11, endLine: 13, depth: 2 },
      { kind: "style", name: "<style>", startLine: 15, endLine: 19, depth: 1 },
      { kind: "rule", name: ".card", startLine: 16, endLine: 18, depth: 2 },
    ]);
  });

  it("extracts Vue and Svelte sections safely with template expressions", () => {
    const vue = [
      "<template>", // 1
      "  <section>", // 2
      "    <h2>{{ a < b && c > d ? 'Hi' : 'Bye' }}</h2>", // 3
      "    <AppModal />", // 4
      "  </section>", // 5
      "</template>", // 6
      "<script setup lang=\"ts\">", // 7
      "const submit = () => {", // 8
      "  return 1;", // 9
      "};", // 10
      "</script>", // 11
    ].join("\n");

    const vueSymbols = extractSymbols("Modal.vue", vue);
    assert.deepEqual(vueSymbols, [
      { kind: "template", name: "<template>", startLine: 1, endLine: 6, depth: 0 },
      { kind: "block", name: "<section>", startLine: 2, endLine: 5, depth: 1 },
      {
        kind: "h2",
        name: "{{ a < b && c > d ? 'Hi' : 'Bye' }}",
        startLine: 3,
        endLine: 3,
        depth: 2,
      },
      { kind: "component", name: "<AppModal>", startLine: 4, endLine: 4, depth: 2 },
      {
        kind: "script",
        name: '<script setup lang="ts">',
        startLine: 7,
        endLine: 11,
        depth: 0,
      },
      { kind: "function", name: "submit", startLine: 8, endLine: 10, depth: 1 },
    ]);

    const svelte = [
      "<script lang=\"ts\">", // 1
      "  function toggle() {", // 2
      "    open = !open;", // 3
      "  }", // 4
      "</script>", // 5
      "{#if count < 5}", // 6
      "  <NavDrawer />", // 7
      "  {@html '</div>'}", // 8
      "{/if}", // 9
    ].join("\n");

    const svelteSymbols = extractSymbols("App.svelte", svelte);
    assert.deepEqual(svelteSymbols, [
      {
        kind: "script",
        name: '<script lang="ts">',
        startLine: 1,
        endLine: 5,
        depth: 0,
      },
      { kind: "function", name: "toggle", startLine: 2, endLine: 4, depth: 1 },
      { kind: "component", name: "<NavDrawer>", startLine: 7, endLine: 7, depth: 0 },
    ]);
  });
});

describe("CSS / SCSS / Less", () => {
  it("extracts rules, @layer, @media, @keyframes, tokens, and SCSS/Less mixins", () => {
    const scss = [
      "@layer base {", // 1
      "  body { margin: 0; }", // 2
      "}", // 3
      "", // 4
      ":root {", // 5
      "  --accent: blue;", // 6
      "}", // 7
      "", // 8
      "@mixin flex-center($gap: 8px) {", // 9
      "  display: flex;", // 10
      "  gap: $gap;", // 11
      "}", // 12
      "", // 13
      ".card,", // 14
      ".panel {", // 15
      "  padding: 1rem;", // 16
      "}", // 17
      "", // 18
      "@media (max-width: 768px) {", // 19
      "  .card { padding: 0.5rem; }", // 20
      "}", // 21
      "", // 22
      "@keyframes fadeIn {", // 23
      "  from { opacity: 0; }", // 24
      "  to { opacity: 1; }", // 25
      "}", // 26
    ].join("\n");

    assert.deepEqual(extractSymbols("theme.scss", scss), [
      { kind: "@layer", name: "base", startLine: 1, endLine: 3, depth: 0 },
      { kind: "tokens", name: ":root", startLine: 5, endLine: 7, depth: 0 },
      { kind: "mixin", name: "flex-center", startLine: 9, endLine: 12, depth: 0 },
      { kind: "rule", name: ".card, .panel", startLine: 14, endLine: 17, depth: 0 },
      {
        kind: "@media",
        name: "(max-width: 768px)",
        startLine: 19,
        endLine: 21,
        depth: 0,
      },
      { kind: "@keyframes", name: "fadeIn", startLine: 23, endLine: 26, depth: 0 },
    ]);

    const less = [
      ".border-radius(@r) {", // 1
      "  border-radius: @r;", // 2
      "}", // 3
      ".btn {", // 4
      "  .border-radius(4px);", // 5
      "}", // 6
    ].join("\n");

    assert.deepEqual(extractSymbols("buttons.less", less), [
      { kind: "mixin", name: ".border-radius", startLine: 1, endLine: 3, depth: 0 },
      { kind: "rule", name: ".btn", startLine: 4, endLine: 6, depth: 0 },
    ]);
  });
});

describe("Shell", () => {
  it("extracts POSIX, bash/zsh, and Allman-style functions with # comments and ${#var}", () => {
    const sh = [
      "#!/usr/bin/env bash", // 1
      "setup_env() {", // 2
      "  # comment with }", // 3
      '  local count="${#ARGS[@]}"', // 4
      "  echo \"$count\"", // 5
      "}", // 6
      "", // 7
      "function deploy-app {", // 8
      "  echo '{ok}'", // 9
      "}", // 10
      "", // 11
      "cleanup()", // 12
      "{", // 13
      "  rm -rf ./tmp", // 14
      "}", // 15
    ].join("\n");

    assert.deepEqual(extractSymbols("release.sh", sh), [
      { kind: "function", name: "setup_env", startLine: 2, endLine: 6, depth: 0 },
      { kind: "function", name: "deploy-app", startLine: 8, endLine: 10, depth: 0 },
      { kind: "function", name: "cleanup", startLine: 12, endLine: 15, depth: 0 },
    ]);
  });
});

describe("Markdown", () => {
  it("extracts ATX headings #..#### with section end lines and ignores fenced code blocks", () => {
    const md = [
      "# Overview", // 1
      "Intro text.", // 2
      "", // 3
      "```bash", // 4
      "# Not a heading", // 5
      "echo hi", // 6
      "```", // 7
      "", // 8
      "## Architecture", // 9
      "Details.", // 10
      "", // 11
      "### Scanner ###", // 12
      "Scanner notes.", // 13
      "", // 14
      "#### Edge Cases", // 15
      "More notes.", // 16
      "", // 17
      "## Usage", // 18
      "Run it.", // 19
    ].join("\n");

    assert.deepEqual(extractSymbols("README.md", md), [
      { kind: "h1", name: "Overview", startLine: 1, endLine: 19, depth: 0 },
      { kind: "h2", name: "Architecture", startLine: 9, endLine: 16, depth: 1 },
      { kind: "h3", name: "Scanner", startLine: 12, endLine: 16, depth: 2 },
      { kind: "h4", name: "Edge Cases", startLine: 15, endLine: 16, depth: 3 },
      { kind: "h2", name: "Usage", startLine: 18, endLine: 19, depth: 1 },
    ]);
  });
});

describe("JSON & YAML", () => {
  it("extracts top-level and depth-1 JSON keys with exact line ranges", () => {
    const json = [
      "{", // 1
      '  "name": "batch-tools",', // 2
      '  "scripts": {', // 3
      '    "test": "node --test",', // 4
      '    "build": {', // 5
      '      "target": "esnext"', // 6
      "    }", // 7
      "  },", // 8
      '  "items": [', // 9
      '    { "ignoredArrayChild": 1 }', // 10
      "  ],", // 11
      '  "note": "has } and \\"quote\\""', // 12
      "}", // 13
    ].join("\n");

    assert.deepEqual(extractSymbols("package.json", json), [
      { kind: "key", name: "name", startLine: 2, endLine: 2, depth: 0 },
      { kind: "key", name: "scripts", startLine: 3, endLine: 8, depth: 0 },
      { kind: "key", name: "test", startLine: 4, endLine: 4, depth: 1 },
      { kind: "key", name: "build", startLine: 5, endLine: 7, depth: 1 },
      { kind: "key", name: "items", startLine: 9, endLine: 11, depth: 0 },
      { kind: "key", name: "note", startLine: 12, endLine: 12, depth: 0 },
    ]);
  });

  it("extracts top-level and depth-1 YAML keys while skipping comments and block scalars", () => {
    const yaml = [
      "---", // 1
      "name: CI", // 2
      "on:", // 3
      "  push:", // 4
      "    branches: [main]", // 5
      "  pull_request:", // 6
      "    branches: [main]", // 7
      "# Jobs section", // 8
      "jobs:", // 9
      "  test:", // 10
      "    runs-on: ubuntu-latest", // 11
      "    steps:", // 12
      "      - run: |", // 13
      "          fake_key: should_not_appear", // 14
      "          echo ok", // 15
      '  "lint":', // 16
      "    runs-on: ubuntu-latest", // 17
    ].join("\n");

    assert.deepEqual(extractSymbols("ci.yaml", yaml), [
      { kind: "key", name: "name", startLine: 2, endLine: 2, depth: 0 },
      { kind: "key", name: "on", startLine: 3, endLine: 7, depth: 0 },
      { kind: "key", name: "push", startLine: 4, endLine: 5, depth: 1 },
      { kind: "key", name: "pull_request", startLine: 6, endLine: 7, depth: 1 },
      { kind: "key", name: "jobs", startLine: 9, endLine: 17, depth: 0 },
      { kind: "key", name: "test", startLine: 10, endLine: 15, depth: 1 },
      { kind: "key", name: "lint", startLine: 16, endLine: 17, depth: 1 },
    ]);
  });
});

describe("Empty, unknown, BOM, and CRLF handling", () => {
  it("returns empty array for empty, whitespace-only, or unknown files", () => {
    assert.deepEqual(extractSymbols("empty.ts", ""), []);
    assert.deepEqual(extractSymbols("blank.py", "   \n\t\n"), []);
    assert.deepEqual(extractSymbolsFromLines("empty.go", []), []);
    assert.deepEqual(
      extractSymbols("notes.txt", "class NotCode\nfunction alsoNotCode() {}"),
      [],
    );
  });

  it("handles UTF-8 BOM and CRLF line endings identically in both entrypoints", () => {
    const content = "\uFEFFexport function hello() {\r\n  return 1;\r\n}\r\n";
    const expected: SymbolEntry[] = [
      { kind: "function", name: "hello", startLine: 1, endLine: 3, depth: 0 },
    ];
    assert.deepEqual(extractSymbols("hello.ts", content), expected);
    assert.deepEqual(
      extractSymbolsFromLines("hello.ts", [
        "\uFEFFexport function hello() {\r",
        "  return 1;\r",
        "}\r",
      ]),
      expected,
    );
  });
});
