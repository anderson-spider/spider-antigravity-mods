import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  clampInt,
  computeWaterFillBudgets,
  fitSectionsToByteBudget,
  sliceSafeBytes,
  sliceSafeChars,
  truncateHeadTailWithByteNotice,
  truncateWithByteNotice,
  utf8ByteLength,
} from "../server/budget.ts";
import {
  globToRegExp,
  normalizeGlobPattern,
  rankFuzzyPaths,
  type FuzzyMatchResult,
} from "../server/fuzzy.ts";

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("budget constants & clampInt", () => {
  it("exports expected inline budget defaults", () => {
    assert.equal(DEFAULT_INLINE_MAX_BYTES, 8_800);
    assert.equal(DEFAULT_MAX_CHARS, 8_500);
  });

  it("clamps integers, truncates floats, and falls back for invalid values", () => {
    assert.equal(clampInt(42, 1, 100, 10), 42);
    assert.equal(clampInt(42.9, 1, 100, 10), 42);
    assert.equal(clampInt(-5, 1, 100, 10), 1);
    assert.equal(clampInt(999, 1, 100, 10), 100);
    assert.equal(clampInt(undefined, 1, 100, 10), 10);
    assert.equal(clampInt(null, 1, 100, 10), 10);
    assert.equal(clampInt(Number.NaN, 1, 100, 10), 10);
    assert.equal(clampInt(Number.POSITIVE_INFINITY, 1, 100, 10), 10);
    assert.equal(clampInt("50", 1, 100, 10), 10);
    assert.equal(Object.is(clampInt(-0, 0, 10, 5), 0), true);
    assert.equal(clampInt(undefined, 5, 10, 100), 10);
    assert.equal(clampInt(7, 10, 5, 6), 7);
  });
});

describe("utf8ByteLength, sliceSafeChars, and sliceSafeBytes", () => {
  it("computes accurate UTF-8 byte lengths across ASCII, 2-byte, CJK, and emoji", () => {
    assert.equal(utf8ByteLength(""), 0);
    assert.equal(utf8ByteLength("abc"), 3);
    assert.equal(utf8ByteLength("café"), 5);
    assert.equal(utf8ByteLength("中文"), 6);
    assert.equal(utf8ByteLength("🚀🔥"), 8);
  });

  it("never splits UTF-16 surrogate pairs in sliceSafeChars", () => {
    const text = "a🚀b🔥c"; // lengths: 'a'(1), '🚀'(2), 'b'(1), '🔥'(2), 'c'(1)
    assert.equal(sliceSafeChars(text, 0), "");
    assert.equal(sliceSafeChars(text, -3), "");
    assert.equal(sliceSafeChars(text, Number.NaN), "");
    assert.equal(sliceSafeChars(text, 1), "a");
    assert.equal(sliceSafeChars(text, 2), "a"); // would cut inside 🚀
    assert.equal(sliceSafeChars(text, 3), "a🚀");
    assert.equal(sliceSafeChars(text, 4), "a🚀b");
    assert.equal(sliceSafeChars(text, 5), "a🚀b"); // would cut inside 🔥
    assert.equal(sliceSafeChars(text, 6), "a🚀b🔥");
    assert.equal(sliceSafeChars(text, 10), text);

    for (let k = 0; k <= text.length + 2; k++) {
      const sliced = sliceSafeChars(text, k);
      assert.equal(hasLoneSurrogate(sliced), false, `lone surrogate at maxChars=${k}`);
      assert.ok(sliced.length <= k);
    }
  });

  it("never exceeds maxBytes or splits UTF-8 / UTF-16 pairs in sliceSafeBytes", () => {
    const samples = [
      "a🚀b中文café🎉end",
      "🚀".repeat(20),
      "日本語テスト文字列",
      "é".repeat(30),
    ];

    for (const sample of samples) {
      const total = utf8ByteLength(sample);
      for (let b = 0; b <= total + 4; b++) {
        const sliced = sliceSafeBytes(sample, b);
        assert.ok(
          utf8ByteLength(sliced) <= b,
          `byte overflow at limit=${b}: got ${utf8ByteLength(sliced)}`,
        );
        assert.equal(
          hasLoneSurrogate(sliced),
          false,
          `lone surrogate at byte limit=${b}`,
        );
      }
    }

    assert.equal(sliceSafeBytes("🚀", 3), "");
    assert.equal(sliceSafeBytes("🚀", 4), "🚀");
    assert.equal(sliceSafeBytes("中", 2), "");
    assert.equal(sliceSafeBytes("中", 3), "中");
    assert.equal(sliceSafeBytes("abc", -1), "");
    assert.equal(sliceSafeBytes("abc", Number.NaN), "");
  });
});

describe("computeWaterFillBudgets", () => {
  it("preserves small sections completely and splits remaining budget evenly", () => {
    const budgets = computeWaterFillBudgets([100, 10_000, 200, 10_000], 1_000);
    assert.deepEqual(budgets, [100, 350, 200, 350]);
    assert.equal(
      budgets.reduce((a, b) => a + b, 0),
      1_000,
    );
  });

  it("distributes odd remainders fairly within +-1 and never exceeds totalBudget", () => {
    const budgets = computeWaterFillBudgets([50, 500, 500, 500], 100);
    // 50 goes to idx 0? Wait: equal share = floor(100/4) = 25, all > 25 => 25 each!
    assert.deepEqual(budgets, [25, 25, 25, 25]);

    const uneven = computeWaterFillBudgets([10, 500, 500, 500], 101);
    // idx 0 keeps 10, remaining 91 split across 3 => 30, 30, 31
    assert.equal(uneven[0], 10);
    const large = uneven.slice(1);
    assert.ok(Math.max(...large) - Math.min(...large) <= 1);
    assert.equal(
      uneven.reduce((a, b) => a + b, 0),
      101,
    );
  });

  it("handles empty, zero/negative budgets, and non-finite sizes safely", () => {
    assert.deepEqual(computeWaterFillBudgets([], 100), []);
    assert.deepEqual(computeWaterFillBudgets([10, 20], 0), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([10, 20], -50), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([10, 20], Number.NaN), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([-5, Number.NaN, 15, 25], 100), [0, 0, 15, 25]);
  });
});

describe("truncateWithByteNotice & truncateHeadTailWithByteNotice", () => {
  it("returns unchanged text when within char and byte limits", () => {
    const res = truncateWithByteNotice("hello 🚀 世界", 100, 100);
    assert.deepEqual(res, { text: "hello 🚀 世界", truncated: false });

    const ht = truncateHeadTailWithByteNotice("hello 🚀 世界", 100, 100);
    assert.deepEqual(ht, { text: "hello 🚀 世界", truncated: false });
  });

  it("enforces strict char and UTF-8 byte caps with noticePrefix and surrogate safety", () => {
    const cjk = "漢字ライン\n".repeat(400);
    const res = truncateWithByteNotice(cjk, 2_000, 600, "[section]");
    assert.equal(res.truncated, true);
    assert.ok(res.text.includes("[section]"));
    assert.ok(res.text.includes("truncated:"));
    assert.ok(res.text.length <= 2_000);
    assert.ok(utf8ByteLength(res.text) <= 600);
    assert.equal(hasLoneSurrogate(res.text), false);

    // Tiny budgets across emoji string
    const emojis = "🚀🔥🎉".repeat(30);
    for (const cap of [0, 1, 2, 3, 4, 5, 10, 25, 55, 80]) {
      const tiny = truncateWithByteNotice(emojis, cap, cap);
      assert.equal(tiny.truncated, true);
      assert.ok(tiny.text.length <= cap, `chars exceeded at cap=${cap}`);
      assert.ok(utf8ByteLength(tiny.text) <= cap, `bytes exceeded at cap=${cap}`);
      assert.equal(hasLoneSurrogate(tiny.text), false, `lone surrogate at cap=${cap}`);
    }
  });

  it("folds middle content in truncateHeadTailWithByteNotice while preserving head and tail", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(3, "0")}: 🚀中文内容`);
    const text = lines.join("\n");

    const res = truncateHeadTailWithByteNotice(text, 1_500, 900);
    assert.equal(res.truncated, true);
    assert.ok(res.text.startsWith("line-000:"));
    assert.ok(res.text.includes("folded"));
    assert.ok(res.text.includes("line-199:"));
    assert.ok(res.text.length <= 1_500);
    assert.ok(utf8ByteLength(res.text) <= 900);
    assert.equal(hasLoneSurrogate(res.text), false);

    // Small budget falls back cleanly
    const small = truncateHeadTailWithByteNotice(text, 60, 60);
    assert.equal(small.truncated, true);
    assert.ok(small.text.length <= 60);
    assert.ok(utf8ByteLength(small.text) <= 60);
    assert.equal(hasLoneSurrogate(small.text), false);
  });
});

describe("fitSectionsToByteBudget", () => {
  it("guarantees <= 8,800 UTF-8 bytes and <= 8,500 chars even with 20 huge sections", () => {
    const hugeAscii = Array.from(
      { length: 20 },
      (_, idx) => `=== Section ${idx} ===\n${"x".repeat(4_000)}`,
    );
    const resAscii = fitSectionsToByteBudget(hugeAscii);
    assert.equal(resAscii.truncated, true);
    assert.ok(utf8ByteLength(resAscii.text) <= DEFAULT_INLINE_MAX_BYTES);
    assert.ok(resAscii.text.length <= DEFAULT_MAX_CHARS);
    assert.equal(hasLoneSurrogate(resAscii.text), false);

    const hugeMultiByte = Array.from(
      { length: 20 },
      (_, idx) => `=== セクション ${idx} 🚀 ===\n${"漢字🚀".repeat(1_500)}`,
    );
    const resMulti = fitSectionsToByteBudget(hugeMultiByte);
    assert.equal(resMulti.truncated, true);
    assert.ok(
      utf8ByteLength(resMulti.text) <= DEFAULT_INLINE_MAX_BYTES,
      `got ${utf8ByteLength(resMulti.text)} bytes`,
    );
    assert.ok(resMulti.text.length <= DEFAULT_MAX_CHARS);
    assert.equal(hasLoneSurrogate(resMulti.text), false);
  });

  it("keeps short sections intact while fairly trimming large sections", () => {
    const shortA = "SHORT_SECTION_A: ok";
    const shortB = "SHORT_SECTION_B: ok";
    const bigA = `BIG_A:\n${"a".repeat(6_000)}`;
    const bigB = `BIG_B:\n${"b".repeat(6_000)}`;

    const res = fitSectionsToByteBudget([shortA, bigA, shortB, bigB], {
      maxChars: 1_000,
      maxBytes: 1_000,
    });
    assert.equal(res.truncated, true);
    assert.ok(res.text.includes(shortA));
    assert.ok(res.text.includes(shortB));
    assert.ok(res.text.includes("BIG_A:"));
    assert.ok(res.text.includes("BIG_B:"));
    assert.ok(res.text.length <= 1_000);
    assert.ok(utf8ByteLength(res.text) <= 1_000);
  });

  it("handles empty inputs, fits-without-truncation, and separator-exceeds-budget edge cases", () => {
    assert.deepEqual(fitSectionsToByteBudget([]), { text: "", truncated: false });
    assert.deepEqual(fitSectionsToByteBudget(["alpha", "beta"]), {
      text: "alpha\n\nbeta",
      truncated: false,
    });

    const manyTiny = Array.from({ length: 30 }, (_, i) => `item-${i}`);
    const cramped = fitSectionsToByteBudget(manyTiny, {
      maxChars: 20,
      maxBytes: 20,
      separator: "\n---\n",
    });
    assert.equal(cramped.truncated, true);
    assert.ok(cramped.text.length <= 20);
    assert.ok(utf8ByteLength(cramped.text) <= 20);
  });
});

describe("normalizeGlobPattern & globToRegExp", () => {
  it("normalizes backslashes, leading ./, redundant globstars, and unbraced a|b alternation", () => {
    assert.equal(normalizeGlobPattern("./src\\**\\*.ts"), "src/**/*.ts");
    assert.equal(normalizeGlobPattern("././a\\b.ts"), "a/b.ts");
    assert.equal(normalizeGlobPattern("src/**/**/*.ts"), "src/**/*.ts");
    assert.equal(normalizeGlobPattern("*.ts|*.tsx"), "{*.ts,*.tsx}");
    assert.equal(normalizeGlobPattern("./src/*.ts | ./tests/*.ts"), "{src/*.ts,tests/*.ts}");
    // Braced or bracketed pipes remain untouched
    assert.equal(normalizeGlobPattern("{a,b}|c"), "{a,b}|c");
    assert.equal(normalizeGlobPattern("[a|b].ts"), "[a|b].ts");
    assert.equal(normalizeGlobPattern("   "), "");
  });

  it("matches *, **, ?, {a,b}, and [abc] accurately", () => {
    const globstar = globToRegExp("src/**/*.ts");
    assert.equal(globstar.test("src/index.ts"), true);
    assert.equal(globstar.test("src/a/b/c.ts"), true);
    assert.equal(globstar.test("src/a/b/c.js"), false);
    assert.equal(globstar.test("lib/index.ts"), false);

    const singleStar = globToRegExp("src/*.ts");
    assert.equal(singleStar.test("src/index.ts"), true);
    assert.equal(singleStar.test("src/sub/index.ts"), false);

    const question = globToRegExp("file?.ts");
    assert.equal(question.test("file1.ts"), true);
    assert.equal(question.test("file12.ts"), false);
    assert.equal(question.test("file/.ts"), false);

    const braces = globToRegExp("src/**/*.{ts,tsx,mts}");
    assert.equal(braces.test("src/a.ts"), true);
    assert.equal(braces.test("src/ui/App.tsx"), true);
    assert.equal(braces.test("src/a.js"), false);

    const nestedBraces = globToRegExp("{src,tests}/**/*.{ts,{js,mjs}}");
    assert.equal(nestedBraces.test("tests/unit/a.mjs"), true);
    assert.equal(nestedBraces.test("src/a.ts"), true);
    assert.equal(nestedBraces.test("docs/a.ts"), false);

    const charClass = globToRegExp("file-[0-9][!a-z].ts");
    assert.equal(charClass.test("file-3X.ts"), true);
    assert.equal(charClass.test("file-3a.ts"), false);
    assert.equal(charClass.test("file-3/.ts"), false);

    const leadingRightBracket = globToRegExp("[]a].ts");
    assert.equal(leadingRightBracket.test("].ts"), true);
    assert.equal(leadingRightBracket.test("a.ts"), true);

    const pipeNormalized = globToRegExp(normalizeGlobPattern("*.ts|*.md"));
    assert.equal(pipeNormalized.test("README.md"), true);
    assert.equal(pipeNormalized.test("index.ts"), true);
    assert.equal(pipeNormalized.test("index.js"), false);
  });

  it("escapes regex metacharacters safely and supports case-insensitive matching", () => {
    const meta = globToRegExp("src/(auth)/page+v1$test.spec.ts");
    assert.equal(meta.test("src/(auth)/page+v1$test.spec.ts"), true);
    assert.equal(meta.test("src/auth/pagev1testXspecXts"), false);

    const literalPipe = globToRegExp("a|b.ts");
    assert.equal(literalPipe.test("a|b.ts"), true);
    assert.equal(literalPipe.test("a"), false);

    const unclosed = globToRegExp("foo[bar{baz.ts");
    assert.equal(unclosed.test("foo[bar{baz.ts"), true);

    const ci = globToRegExp("README.md", false);
    assert.equal(ci.test("readme.MD"), true);
    assert.equal(globToRegExp("README.md", true).test("readme.MD"), false);
  });

  it("rejects pathological ReDoS-prone glob patterns", () => {
    assert.throws(() => globToRegExp("*a".repeat(40)), /maximum wildcard segments/i);
    assert.throws(() => globToRegExp("a".repeat(3_000)), /maximum length/i);
    assert.throws(
      () => globToRegExp("{".repeat(10) + "a" + "}".repeat(10)),
      /maximum depth/i,
    );
  });
});

describe("rankFuzzyPaths", () => {
  it("ranks exact basename > prefix > boundary/camelCase > directory-only > scattered", () => {
    const candidates = [
      "src/b_u_d_g_e_t.ts",
      "src/subbudget/index.ts",
      "plugins/batch-tools/tests/budget.test.ts",
      "plugins/batch-tools/server/budget.ts",
      "budget.ts",
      "src/other/unrelated.ts",
    ];

    const ranked: FuzzyMatchResult[] = rankFuzzyPaths(candidates, "budget.ts");
    assert.equal(ranked[0]?.path, "budget.ts");
    assert.equal(ranked[1]?.path, "plugins/batch-tools/server/budget.ts");
    assert.equal(
      ranked.some((r) => r.path === "src/other/unrelated.ts"),
      false,
    );

    const byStem = rankFuzzyPaths(candidates, "budget");
    assert.equal(byStem[0]?.path, "budget.ts");
    assert.equal(byStem[1]?.path, "plugins/batch-tools/server/budget.ts");
    const dirOnlyIdx = byStem.findIndex((r) => r.path === "src/subbudget/index.ts");
    const scatteredIdx = byStem.findIndex((r) => r.path === "src/b_u_d_g_e_t.ts");
    assert.ok(dirOnlyIdx > 1);
    assert.ok(scatteredIdx > 1);
  });

  it("favors camelCase and separator boundaries for initialism queries", () => {
    const candidates = [
      "src/about.ts",
      "src/batchTools.ts",
      "src/batch-tools.ts",
      "src/sub/ab_ct.ts",
    ];
    const ranked = rankFuzzyPaths(candidates, "bt");
    const topTwo = new Set(ranked.slice(0, 2).map((r) => r.path));
    assert.equal(topTwo.has("src/batchTools.ts"), true);
    assert.equal(topTwo.has("src/batch-tools.ts"), true);
    assert.equal(ranked[2]?.path, "src/about.ts");
  });

  it("supports multi-token queries, Unicode paths, limit, and deterministic tie-breaking", () => {
    const tied = ["c/foo.ts", "a/foo.ts", "b/foo.ts"];
    const rankedTied = rankFuzzyPaths(tied, "foo");
    assert.deepEqual(
      rankedTied.map((r) => r.path),
      ["a/foo.ts", "b/foo.ts", "c/foo.ts"],
    );

    const limited = rankFuzzyPaths(tied, "foo", 2);
    assert.equal(limited.length, 2);
    assert.deepEqual(
      limited.map((r) => r.path),
      ["a/foo.ts", "b/foo.ts"],
    );

    assert.deepEqual(rankFuzzyPaths(tied, "foo", 0), []);
    assert.deepEqual(rankFuzzyPaths(tied, "   "), []);

    const multi = rankFuzzyPaths(
      [
        "plugins/batch-tools/server/budget.ts",
        "plugins/batch-tools/tests/budget.test.ts",
        "plugins/gitlab/tests/mcp.test.ts",
      ],
      "budget test",
    );
    assert.deepEqual(
      multi.map((r) => r.path),
      ["plugins/batch-tools/tests/budget.test.ts"],
    );

    const unicode = rankFuzzyPaths(
      ["docs/café-guide.md", "docs/日本語/設定.md", "docs/other.md"],
      "設定",
    );
    assert.deepEqual(
      unicode.map((r) => r.path),
      ["docs/日本語/設定.md"],
    );
  });
});
