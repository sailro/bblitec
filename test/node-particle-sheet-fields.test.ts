import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const fileName = resolve("corpus/babylon-lite/lab/lite/src/lite/scene300.ts");
const original = readFileSync(fileName, "utf8");
const initialized = original.slice(0, original.indexOf("    const buffer = system.buffer;"));
function compile(fields: string) {
    return compileSource(`${initialized}
        let effects = 0;
        function otherCells() { effects += 1; return new Uint16Array(600); }
        function key() { effects += 1; return "cellWidth"; }
        const cells = new Uint16Array(600);
        system._spriteSheet = { ${fields} };
    }
    main();`, { fileName });
}

test("frozen sprite sheets refuse duplicate widths instead of using the first value", () => {
    assert.throws(() => compile(`
        cellWidth: 64, "cellWidth": 128, cellHeight: 64,
        cellIndex: cells, update: () => undefined
    `), /scene300\.ts:\d+:\d+: A frozen particle sprite sheet cannot repeat field 'cellWidth'/);
});

test("frozen sprite sheets refuse duplicate cell arrays instead of erasing later effects", () => {
    assert.throws(() => compile(`
        cellWidth: 64, cellHeight: 64, cellIndex: cells,
        cellIndex: otherCells(), update: () => undefined
    `), /scene300\.ts:\d+:\d+: A frozen particle sprite sheet cannot repeat field 'cellIndex'/);
});

test("frozen sprite sheets refuse computed keys instead of repeatedly evaluating them", () => {
    assert.throws(() => compile(`
        [key()]: 64, cellHeight: 64, cellIndex: cells, update: () => undefined
    `), /scene300\.ts:\d+:\d+: A frozen particle sprite sheet requires named, non-computed fields/);
});

test("named frozen sprite-sheet fields preserve one cell-array evaluation", () => {
    const result = compile(`
        "cellWidth": 64, cellHeight: 64, cellIndex: otherCells(), update: () => undefined
    `);
    assert.equal(result.cpp.match(/v_effects \+= 1\.0/g)?.length, 1);
    assert.match(result.cpp, /set_frozen_node_particle_sheet\(0, 0, 64\.0, 64\.0,/);
});
