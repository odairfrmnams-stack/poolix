import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { identiconSpec, identiconSvgString } from "@/lib/identicon";

const A = "0x1111111111111111111111111111111111111111";
const A_UPPER = A.toUpperCase();
const B = "0x2222222222222222222222222222222222222222";

describe("identiconSpec", () => {
  it("returns a fixed-size mirrored 5x5 grid", () => {
    const spec = identiconSpec(A);
    assert.equal(spec.cells.length, 25);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        assert.equal(
          spec.cells[row * 5 + col],
          spec.cells[row * 5 + (4 - col)],
          `row ${row} col ${col} broke the mirror`,
        );
      }
    }
  });

  it("is deterministic across repeated calls", () => {
    const first = identiconSpec(A);
    const second = identiconSpec(A);
    assert.deepEqual(first, second);
  });

  it("is case-insensitive on the seed", () => {
    assert.deepEqual(identiconSpec(A), identiconSpec(A_UPPER));
  });

  it("produces different pictures for different seeds", () => {
    const one = identiconSpec(A);
    const two = identiconSpec(B);
    // Either the palette or the cell pattern must differ; anything else would be a
    // hash collision on this tiny corpus, and we would want to know.
    const sameCells = one.cells.every((v, i) => v === two.cells[i]);
    const samePalette = one.foreground === two.foreground && one.background === two.background;
    assert.equal(sameCells && samePalette, false);
  });

  it("handles the empty seed without throwing", () => {
    const spec = identiconSpec("");
    assert.equal(spec.cells.length, 25);
  });
});

describe("identiconSvgString", () => {
  it("emits an SVG with the requested pixel size", () => {
    const svg = identiconSvgString(A, 40);
    assert.ok(svg.startsWith("<svg"), "should start with <svg");
    assert.ok(svg.includes(`width="40"`), "width should be set");
    assert.ok(svg.includes(`height="40"`), "height should be set");
    assert.ok(svg.includes(`viewBox="0 0 5 5"`), "viewBox should be 0 0 5 5");
  });

  it("contains no script, foreignObject or javascript: reference", () => {
    // Whatever the seed, the output must be a fixed, boring subset of SVG.
    for (const seed of [A, B, "", "🚀", "<script>alert(1)</script>"]) {
      const svg = identiconSvgString(seed, 32);
      assert.equal(svg.includes("<script"), false, `script in ${seed}`);
      assert.equal(svg.includes("<foreignObject"), false, `foreignObject in ${seed}`);
      assert.equal(svg.toLowerCase().includes("javascript:"), false, `js: in ${seed}`);
      assert.equal(svg.includes("onerror"), false);
      assert.equal(svg.includes("onload"), false);
    }
  });

  it("produces the same string for the same seed at the same size", () => {
    assert.equal(identiconSvgString(A, 32), identiconSvgString(A, 32));
  });
});
