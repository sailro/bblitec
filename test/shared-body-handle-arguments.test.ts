import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

// A body no call re-enters specializes on each caller's handles: a record of
// materials stays the caller's compile-time binding, so an API that reads its
// material at generation (a local environment) knows which one it is.
const source = `
import { createEngine, createPbrMaterial, type PbrMaterialProps } from "babylon-lite";
interface Pair { floor: PbrMaterialProps; back: PbrMaterialProps }
function tune(materials: Pair, level: number): void {
    materials.floor.directIntensity = level;
    materials.back.environmentIntensity = 0;
}
async function main() {
    await createEngine({});
    const a: Pair = { floor: createPbrMaterial({}), back: createPbrMaterial({}) };
    const b: Pair = { floor: createPbrMaterial({}), back: createPbrMaterial({}) };
    tune(a, 0);
    tune(b, 1);
}
main();
`;

test("a non-recursive body binds a record of materials per call, not as a runtime argument", () => {
    const { cpp } = compileSource(source);
    const signature = /^void (bbl_recursive_fn\d+_group)\(([^)]*)\);$/m.exec(
        cpp,
    );
    assert.ok(signature, "the shared body");
    assert.doesNotMatch(signature[2]!, /Pair/);
    assert.match(signature[2]!, /double/);
});
