/**
 * Generated-code hygiene the lowering owns: no local or record member is left
 * indeterminate, a value body that provably returns carries no unreachable
 * fallthrough, and a runtime-selected packaged fetch shares one table.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const fallthrough = /fell through without returning/;

test("a switch with a default whose every clause returns needs no fallthrough", () => {
    const result = compileSource(`
        function sign(value: number): number {
            switch (Math.sign(value)) {
                case 1:
                    return 10;
                case -1:
                case -0:
                    return -10;
                default:
                    return 0;
            }
        }
        if (sign(Date.now()) + sign(-Date.now()) !== 0) throw new Error("sign");
    `);
    assert.doesNotMatch(result.cpp, fallthrough);
});

test("a switch a clause leaves by break keeps what follows it", () => {
    for (const body of [
        "switch (value) { case 1: return 1; default: break; } return 77;",
        "switch (value) { case 1: break; default: return 2; } return 77;",
    ]) {
        const result = compileSource(`
            function pick(value: number): number { ${body} }
            if (pick(Date.now() % 4) > 90) throw new Error("pick");
        `);
        assert.match(result.cpp, /return 77(\.0)?;/, body);
        assert.doesNotMatch(result.cpp, fallthrough, body);
    }
});

test("an endless loop left only by return needs no fallthrough", () => {
    const result = compileSource(`
        function firstAbove(values: number[], limit: number): number {
            let index = 0;
            while (true) {
                if (index >= values.length) return -1;
                if (values[index]! > limit) return index;
                index++;
            }
        }
        if (firstAbove([1, 5, Date.now()], 4) !== 1) throw new Error("above");
    `);
    assert.doesNotMatch(result.cpp, fallthrough);
    const leaving = compileSource(`
        function count(values: number[]): number {
            let index = 0;
            for (;;) {
                if (index >= values.length) break;
                index++;
            }
            return index;
        }
        if (count([1, Date.now()]) !== 2) throw new Error("count");
    `);
    assert.match(leaving.cpp, /return v_\w*index;/);
});

test("an exhaustive switch without a default keeps the fallthrough", () => {
    const result = compileSource(`
        type Side = "left" | "right";
        function offset(side: Side): number {
            switch (side) {
                case "left":
                    return -1;
                case "right":
                    return 1;
            }
        }
        const sides: Side[] = ["left", "right"];
        if (offset(sides[Date.now() % 2]!) === 0) throw new Error("offset");
    `);
    assert.match(result.cpp, fallthrough);
});

test("declarations without an initializer and record members are value-initialized", () => {
    const result = compileSource(`
        interface Span { start: number; end: number; open: boolean; }
        function measure(values: number[]): Span {
            let start: number;
            let end: number;
            if (values.length > 0) {
                start = values[0]!;
                end = values[values.length - 1]!;
            } else {
                start = 0;
                end = 0;
            }
            return { start, end, open: values.length > 1 };
        }
        const spans: Span[] = [measure([Date.now(), 2]), measure([])];
        if (spans[1]!.open) throw new Error("span");
    `);
    assert.match(result.cpp, /double v_\w*start\{\};/);
    assert.match(result.cpp, /double v_\w*end\{\};/);
    assert.doesNotMatch(result.cpp, /double v_\w*(start|end);/);
    assert.match(
        result.cpp,
        /struct Span(Data)? \{\s+double start\{\};\s+double end\{\};\s+bool open\{\};/,
    );
});

test("runtime-selected packaged fetches share one namespace-scope table", () => {
    const result = compileSource(
        `
            import { createAudioEngineAsync } from "@babylonjs/lite";

            async function loadSound(ctx: BaseAudioContext, name: string) {
                const response = await fetch(
                    "fixtures/compiler-modules/dynamic-audio/" + name
                );
                return ctx.decodeAudioData(await response.arrayBuffer());
            }

            async function loadAgain(ctx: BaseAudioContext, name: string) {
                const again = await fetch(
                    "fixtures/compiler-modules/dynamic-audio/" + name
                );
                return ctx.decodeAudioData(await again.arrayBuffer());
            }

            async function main() {
                const audio = await createAudioEngineAsync();
                const name = Math.random() < 0.5 ? "tone.wav" : "tone.wav";
                await loadSound(audio.audioContext, name);
                await loadAgain(audio.audioContext, name);
            }
            main();
        `,
        { fileName: "test/compiler-dynamic-audio-entry.ts" },
    );
    const tables = result.cpp.match(
        /std::array<std::pair<std::string_view, std::string_view>, 1> packaged_asset_paths\w*\{/g,
    );
    assert.equal(tables?.length, 1);
    assert.equal(
        result.cpp.split(result.manifest.assets[0]!.output).length - 1,
        1,
    );
    assert.match(
        result.cpp,
        /for \(const auto& \[source, output\] : bblscene::packaged_asset_paths\w*\)/,
    );
    assert.doesNotMatch(
        result.cpp,
        /thread_local bbl::js::Map<std::string, std::string>/,
    );
});
