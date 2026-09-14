import assert from "node:assert/strict";
import test from "node:test";
import { androidPackageArguments } from "../src/shipping-android.js";

test("Android packaging passes the requested target and keeps shared work serialized", () => {
    const values = new Map([
        ["--abi", "x86_64"], ["--sdk", "C:/SDK with spaces"],
        ["--device", "emulator-5554"], ["--jobs", "3"], ["--workers", "1"],
    ]);
    const args = androidPackageArguments("torus-states", values);
    for (const [flag, expected] of [["-Platform", "android"], ["-Scene", "torus-states"],
        ["-Abi", "x86_64"], ["-Sdk", "C:/SDK with spaces"], ["-Device", "emulator-5554"], ["-Jobs", "3"]]) {
        assert.equal(args[args.indexOf(flag!) + 1], expected);
    }
    assert.throws(() => androidPackageArguments("torus-states", new Map([["--abi", "x86"]])), /ABI/);
    assert.throws(() => androidPackageArguments("torus-states", new Map([["--jobs", "0"]])), /positive/);
    assert.throws(() => androidPackageArguments("torus-states", new Map([["--workers", "2"]])), /share dependencies/);
});
