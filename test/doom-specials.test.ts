import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    buildNativeFixture,
    optionalNativeFixtureTools,
} from "./native-fixture.js";

test("Doom USE lowers and raises lifts while manual doors retain their sector", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native compiler is required.");
        return;
    }
    const directory = resolve("artifacts/doom-specials");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(
        `
        import { SpecialsManager } from "../../corpus/babylon-lite/lab/lite/src/demos/doom/specials/specials.js";
        import type { DoomMap } from "../../corpus/babylon-lite/lab/lite/src/demos/doom/wad/map.js";
        const map: DoomMap = {
            name: "interaction-fixture",
            vertices: [{ x: 32, y: -16 }, { x: 32, y: 16 }, { x: 32, y: 48 }, { x: 32, y: 80 }],
            linedefs: [
                { start: 0, end: 1, flags: 0, special: 62, tag: 7, front: 0, back: 1 },
                { start: 2, end: 3, flags: 0, special: 1, tag: 0, front: 0, back: 2 },
            ],
            sidedefs: [
                { xOffset: 0, yOffset: 0, upper: "-", middle: "SW1TEST", lower: "-", sector: 0 },
                { xOffset: 0, yOffset: 0, upper: "-", middle: "-", lower: "-", sector: 1 },
                { xOffset: 0, yOffset: 0, upper: "-", middle: "-", lower: "-", sector: 2 },
            ],
            sectors: [
                { floorHeight: 0, ceilHeight: 128, floorTex: "FLOOR", ceilTex: "CEIL", light: 160, special: 0, tag: 0 },
                { floorHeight: 64, ceilHeight: 128, floorTex: "FLOOR", ceilTex: "CEIL", light: 160, special: 0, tag: 7 },
                { floorHeight: 0, ceilHeight: 0, floorTex: "FLOOR", ceilTex: "CEIL", light: 160, special: 0, tag: 0 },
            ],
            segs: [], subsectors: [], nodes: [], things: [],
        };
        const specials = new SpecialsManager(map, { playerSector: () => 0 });
        const lift = map.sectors[1]!;
        const door = map.sectors[2]!;
        specials.tryUse(0, 0, 0);
        specials.tic();
        if (lift.floorHeight !== 60 || map.sectors[1]!.floorHeight !== 60 || !specials.consumeDirty())
            throw new Error("USE must lower the actual lift sector");
        if (specials.consumeDirty() || map.sidedefs[0]!.middle !== "SW2TEST")
            throw new Error("switch texture and dirty reset");
        for (let i = 0; i < 15; i++) specials.tic();
        if (lift.floorHeight !== 0) throw new Error("lift must reach its lower stop");
        for (let i = 0; i < 105; i++) specials.tic();
        if (lift.floorHeight !== 0) throw new Error("lift must wait before rising");
        for (let i = 0; i < 16; i++) specials.tic();
        if (lift.floorHeight !== 64) throw new Error("lift must return to its original height");
        specials.tryUse(0, 0, 0);
        specials.tic();
        if (lift.floorHeight !== 60) throw new Error("lift must be reusable");
        specials.tryUse(0, 64, 0);
        specials.tic();
        if (door.ceilHeight !== 2) throw new Error("manual door must still open");
        specials.tryUse(0, 64, 0);
        specials.tic();
        if (door.ceilHeight !== 0) throw new Error("manual door must reverse on reuse");
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    for (const [path, cpp] of result.cppFiles) {
        const full = resolve(directory, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, cpp);
    }
    const executable = resolve(directory, "check.exe");
    buildNativeFixture(
        tools,
        result.manifest.sourceUnits.map(({ path }) => resolve(directory, path)),
        executable,
        [
            "/nologo",
            "/std:c++20",
            "/EHsc",
            "/W4",
            "/WX",
            `/I${resolve("native/include")}`,
        ],
    );
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});
