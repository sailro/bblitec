import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("typed-array union set preserves the selected storage and ordered argument reads", (t) => {
    const source = `
type Values = Float32Array | Float64Array;
function copy(target: Values, source: Values | number[], offset = 0): void {
    target.set(source, offset);
}
const wide = new Float64Array(6), narrow = new Float32Array(6);
const wideView = wide.subarray(1, 5), narrowView = narrow.subarray(1, 5);
const precise = 1.0000000000000002;
copy(wideView, new Float64Array([precise, 2]));
copy(narrowView, new Float64Array([precise, 2]));
if (wide[1] !== precise || narrow[1] !== 1 || wide[0] !== 0 || narrow[5] !== 0) throw new Error("selected precision and view");
copy(wideView, new Float32Array([3, 4]), 2);
copy(wideView, wideView.subarray(0, 3), 1);
if (wide[1] !== precise || wide[2] !== precise || wide[3] !== 2 || wide[4] !== 3) throw new Error("overlap snapshot");
copy(narrowView, [5, 6]);
if (narrow[1] !== 5 || narrow[2] !== 6) throw new Error("numeric source");
const order: number[] = [];
const donor = new Float64Array([0, 7, 8, 0]);
let selected: {matrices: Values} = {matrices: wideView};
let selectedSource: Values = donor.subarray(1, 3);
function receiver(): {matrices: Values} { order.push(1); return selected; }
function values(): Values { order.push(2); selected = {matrices: narrowView}; return selectedSource; }
function offset(): number {
    order.push(3); selectedSource = new Float32Array([9, 10]); donor[1] = precise;
    return 1;
}
receiver().matrices.set(values(), offset());
if (order.join(",") !== "1,2,3" || wide[2] !== precise || wide[3] !== 8 || narrow[2] !== 6) throw new Error("receiver/source ownership or evaluation order");
function literal(target: Values): void { target.set([11, 12], 2); }
literal(wideView);
if (wide[3] !== 11 || wide[4] !== 12) throw new Error("literal source");
let failures = 0;
try { copy(wideView, new Float64Array([1,2,3,4,5])); } catch { failures++; }
try { copy(narrowView, new Float32Array([1]), -1); } catch { failures++; }
if (failures !== 2 || wide[3] !== 11 || narrow[1] !== 5) throw new Error("range check before stores");
`;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    assert.match(result.cpp, /std::visit/);
    assert.match(result.cpp, /bbl::js::typed_array_from_values/);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "typed-array-union-set", result.cpp);
});
