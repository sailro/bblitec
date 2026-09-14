import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { androidPackageArguments } from "../src/shipping-android.js";

const cmake = discoverDevelopmentTools().cmake;
test("Android sweep installs only dependencies reached by its selected scenes", { skip: !cmake }, t => {
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/android-sweep-dependencies-"));
    assert.equal(dirname(directory), resolve("artifacts"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const scenes = [join(directory, "first scene"), join(directory, "second scene")];
    for (const scene of scenes) mkdirSync(scene);
    const sourceList = join(directory, "directories.txt");
    const output = join(directory, "dependencies.txt");
    writeFileSync(sourceList, scenes.map(scene => scene.replaceAll("\\", "/")).join("\n"));
    const featureFile = (scene: string, runtime: string) => writeFileSync(join(scene, "features.cmake"),
        `set(BBLITE_RUNTIME_FEATURES ${runtime})\nset(BBLITE_IMAGE_CODECS "")\n`);
    const profile = () => {
        execFileSync(cmake!, [`-DBBLITE_GENERATED_DIRS_FILE=${sourceList}`,
            `-DBBLITE_PROFILE_OUTPUT=${output}`, "-P", "tools/android-sweep-dependencies.cmake"], { stdio: "pipe" });
        return readFileSync(output, "utf8").trim().split(";");
    };
    featureFile(scenes[0]!, "physics:world");
    featureFile(scenes[1]!, "physics:world text:layout");
    assert.deepEqual(profile(), ["physics", "png", "text-layout"]);
    featureFile(scenes[0]!, "data:locale platform:http");
    assert.deepEqual(profile(), ["http", "locale", "physics", "png", "text-layout"]);
});

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
