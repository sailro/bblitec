import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { computeBuildStamp } from "../src/build-stamp.js";
import { discoverDevelopmentTools, discoverWindowsBuildTools } from "../src/development-tools.js";
import { applicationScenes } from "../src/scene-registry.js";
import { packageSizeReport, preserveShippingPayload, readShippingFeatures, selectShippingScenes,
    shippingConfigureArguments, shippingPlan, type ShippingFeatures } from "../src/shipping-demos.js";

const tools = discoverDevelopmentTools();
const sample = applicationScenes[0]!;
const core: ShippingFeatures = { features: [], codecs: [], runtime: [] };

test("shipping selects all application registry entries and refuses paths or duplicate IDs", () => {
    assert.deepEqual(selectShippingScenes(undefined), applicationScenes);
    assert.deepEqual(selectShippingScenes("all"), applicationScenes);
    assert.deepEqual(selectShippingScenes(sample.id), [sample]);
    for (const value of ["../scene", "scene1", `${sample.id},${sample.id}`, ""]) {
        assert.throws(() => selectShippingScenes(value));
    }
    assert.throws(() => shippingPlan(process.cwd(), [{ scene: { ...sample, id: "../escape" }, reached: core }]));
});

test("static installs share optional libraries only within the exact image-codec set", () => {
    const rows = [
        { scene: sample, reached: { features: ["png"], codecs: ["png"], runtime: [] } },
        { scene: { ...sample, id: "second" }, reached: { features: ["png", "physics"], codecs: ["png"], runtime: ["physics:world"] } },
        { scene: { ...sample, id: "third" }, reached: { features: ["webp"], codecs: ["webp"], runtime: ["audio:engine", "audio:decoded-buffer", "input:gamepad", "ui:inline-svg"] } },
        { scene: { ...sample, id: "fourth" }, reached: core },
    ];
    const plan = shippingPlan(resolve("artifacts/fixture root"), rows);
    assert.equal(plan.profiles.length, 3);
    assert.equal(plan.scenes[0]!.installedDirectory, plan.scenes[1]!.installedDirectory);
    assert.notEqual(plan.scenes[0]!.installedDirectory, plan.scenes[2]!.installedDirectory);
    assert.deepEqual(plan.profiles[0]!.features, ["physics", "png"]);
    assert.deepEqual(plan.profiles[1]!.features, ["webp"]);
    assert.deepEqual(plan.profiles[2]!.features, []);
    assert.match(plan.scenes[0]!.sdlDirectory, /sdl-min$/);
    assert.match(plan.scenes[2]!.sdlDirectory, /sdl-min-audio-gamepad$/);
    assert.match(plan.scenes[2]!.labSoundDirectory, /labsound-static-codecs$/);
    assert.match(plan.scenes[2]!.rmlUiDirectory, /rmlui-static-svg$/);
    assert.throws(() => readShippingFeatures("features=png\ncodecs=../escape\nruntime="));
    assert.throws(() => readShippingFeatures("features=png"));
});

test("shipping profile executes the native dependency predicates including navigation, SVG and text", { skip: !tools.cmake }, t => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-shipping-profile-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const cases = [
        { runtime: [], codecs: [], expected: [] },
        { runtime: ["ui:rml"], codecs: ["png"], expected: ["png", "ui"] },
        { runtime: ["ui:rml", "ui:inline-svg"], codecs: ["webp", "jpeg"], expected: ["jpeg", "ui", "ui-svg", "webp"] },
        { runtime: ["physics:world", "navigation:recast", "navigation:crowd", "navigation:tile-cache", "text:layout"], codecs: [],
            expected: ["navigation", "navigation-crowd", "navigation-tile-cache", "physics", "text-layout"] },
    ];
    for (const fixture of cases) {
        const quotes = (values: string[]): string => values.length ? values.map(value => `"${value}"`).join(" ") : '""';
        writeFileSync(join(directory, "features.cmake"), `set(BBLITE_RUNTIME_FEATURES ${quotes(fixture.runtime)})\nset(BBLITE_IMAGE_CODECS ${quotes(fixture.codecs)})\n`);
        const output = join(directory, "profile.txt");
        const result = spawnSync(tools.cmake!, [`-DBBLITE_GENERATED_DIR=${directory}`, `-DBBLITE_PROFILE_OUTPUT=${output}`,
            "-P", resolve("tools/shipping-profile.cmake")], { encoding: "utf8", windowsHide: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const parsed = readShippingFeatures(readFileSync(output, "utf8"));
        assert.deepEqual(parsed.features, fixture.expected);
        assert.deepEqual(parsed.codecs, [...fixture.codecs].sort());
    }
    writeFileSync(join(directory, "features.cmake"), "set(BBLITE_IMAGE_CODECS unknown)\n");
    const rejected = spawnSync(tools.cmake!, [`-DBBLITE_GENERATED_DIR=${directory}`, `-DBBLITE_PROFILE_OUTPUT=${join(directory, "profile.txt")}`,
        "-P", resolve("tools/shipping-profile.cmake")], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unknown BBLITE_IMAGE_CODECS/);
});

test("fresh shipping configure removes obsolete package paths and pins the static MSVC shape", { skip: process.platform !== "win32" || !tools.cmake }, t => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-shipping-cache-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const native = join(directory, "native");
    mkdirSync(native);
    writeFileSync(join(native, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.24)\nproject(shipping_cache NONE)\n");
    const toolchainFile = join(directory, "toolchain.cmake");
    writeFileSync(toolchainFile, "");
    const toolchain = discoverWindowsBuildTools("msvc");
    const scene = shippingPlan(directory, [{ scene: sample, reached: core }]).scenes[0]!;
    const args = shippingConfigureArguments(directory, scene, toolchain, toolchainFile);
    for (const required of ["--fresh", "-DBBLITE_MINSIZE=ON", "-DBBLITE_BACKEND=SDL_GPU", "-DBBLITE_PCH=OFF",
        "-DVCPKG_TARGET_TRIPLET=x64-windows-static", "-DVCPKG_MANIFEST_INSTALL=OFF", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
        "-DBBLITE_VISUAL_CAPTURE=OFF", "-DBBLITE_AUDIO_CAPTURE=OFF"]) assert.ok(args.includes(required), required);
    assert.ok(args.includes(`-DCMAKE_CXX_COMPILER=${toolchain.compiler}`));
    for (const extra of [["-DSDL3_image_DIR=C:/obsolete/static-superset"], []]) {
        const result = spawnSync(tools.cmake!, [...args, ...extra], { encoding: "utf8", windowsHide: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const cache = readFileSync(join(scene.buildDirectory, "CMakeCache.txt"), "utf8");
        assert.equal(cache.includes("C:/obsolete/static-superset"), extra.length > 0);
    }
});

test("obsolete deployment is preserved without moving the executable or native objects", t => {
    const root = mkdtempSync(join(tmpdir(), "bblite-shipping-payload-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "native/build-demo-min-sdl");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "assets/old.bin"), "old asset");
    writeFileSync(join(directory, "SDL3.dll"), "old dll");
    writeFileSync(join(directory, "bblite-shaders-deployed.stamp"), "deployed");
    writeFileSync(join(directory, "bblite_native.exe"), "old executable");
    writeFileSync(join(directory, "object.obj"), "cached object");
    assert.throws(() => preserveShippingPayload(root, "../escape"));
    preserveShippingPayload(root, "demo");
    const backup = readdirSync(directory).find(name => name.startsWith(".payload-"));
    assert.ok(backup);
    assert.equal(readFileSync(join(directory, backup, "assets/old.bin"), "utf8"), "old asset");
    assert.equal(readFileSync(join(directory, backup, "SDL3.dll"), "utf8"), "old dll");
    assert.equal(readFileSync(join(directory, "bblite_native.exe"), "utf8"), "old executable");
    assert.ok(existsSync(join(directory, "object.obj")));
    assert.ok(!existsSync(join(directory, "assets")));
    assert.ok(!existsSync(join(directory, "bblite-shaders-deployed.stamp")), "Ninja must redeploy after moving the shader directory");
});

test("extracted dependency choices remain part of the native build stamp", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-shipping-stamp-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "native"));
    mkdirSync(join(directory, "generated"));
    writeFileSync(join(directory, "native/CMakeLists.txt"), "include(dependency-features.cmake)");
    writeFileSync(join(directory, "native/dependency-features.cmake"), "set(FEATURE one)");
    const before = computeBuildStamp(join(directory, "generated"), directory);
    writeFileSync(join(directory, "native/dependency-features.cmake"), "set(FEATURE another)");
    const after = computeBuildStamp(join(directory, "generated"), directory);
    assert.notEqual(before.stamp, after.stamp);
    assert.ok(after.inputs.some(input => input.path === "native/dependency-features.cmake"));
});

test("package publication keeps failed staging and the comparison baseline separate from replacements", { skip: !tools.powershell }, t => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-shipping-publication-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const script = join(directory, "check.ps1");
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
Import-Module $env:BBLITE_TEST_PACKAGE_MODULE -Force
$root = $env:BBLITE_TEST_PACKAGE_ROOT
$name = 'bblitec-demo-sdl-gpu-windows-x64'
New-Item -ItemType Directory -Path (Join-Path $root $name),(Join-Path $root '@previous') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $root "$name/old.txt") -Value 'old package'
Set-Content -LiteralPath (Join-Path $root "$name.zip") -Value 'old zip'
Set-Content -LiteralPath (Join-Path $root '@previous/baseline.zip') -Value 'comparison baseline'
$plan = New-PackageOutput $root $name
$failed = $false
try { Publish-PackageOutput $plan } catch { $failed = $true }
if (-not $failed -or -not (Test-Path -LiteralPath (Join-Path $root "$name/old.txt"))) { throw 'failed staging changed prior package' }
New-Item -ItemType Directory -Path (Join-Path $plan.Staging $name) | Out-Null
Set-Content -LiteralPath (Join-Path $plan.Staging "$name/new.txt") -Value 'new package'
Set-Content -LiteralPath (Join-Path $plan.Staging "$name.zip") -Value 'new zip'
Set-Content -LiteralPath (Join-Path $plan.Staging "$name.json") -Value '{}'
Publish-PackageOutput $plan
if ((Get-Content -LiteralPath (Join-Path $plan.Previous "$name/old.txt")) -ne 'old package') { throw 'prior package lost' }
if ((Get-Content -LiteralPath (Join-Path $plan.Previous "$name.zip")) -ne 'old zip') { throw 'prior zip lost' }
if ((Get-Content -LiteralPath (Join-Path $root "$name/new.txt")) -ne 'new package') { throw 'new package missing' }
if ((Get-Content -LiteralPath (Join-Path $root '@previous/baseline.zip')) -ne 'comparison baseline') { throw 'baseline changed' }
if (@(Get-ChildItem -LiteralPath (Join-Path $root '@previous')).Count -ne 1) { throw 'baseline acquired files' }
foreach ($invalid in @('../escape', 'bblitec-../escape-windows-x64')) {
    $rejected = $false
    try { New-PackageOutput $root $invalid | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'unsafe name accepted' }
}
$rejected = $false
try { Assert-PackageChild $root (Join-Path $root '../outside') } catch { $rejected = $true }
if (-not $rejected) { throw 'escaping path accepted' }
$outside = Join-Path $root 'external'
New-Item -ItemType Directory -Path $outside | Out-Null
$link = Join-Path $root '.staging/link'
New-Item -ItemType Junction -Path $link -Target $outside | Out-Null
$rejected = $false
try { Assert-PackageChild $root (Join-Path $link 'payload') } catch { $rejected = $true }
if (-not $rejected) { throw 'junction accepted' }
`);
    const result = spawnSync(tools.powershell!, ["-NoProfile", "-File", script], { encoding: "utf8", windowsHide: true,
        env: { ...process.env, BBLITE_TEST_PACKAGE_MODULE: resolve("tools/package-output.psm1"), BBLITE_TEST_PACKAGE_ROOT: directory } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("size report exposes growth and shrinkage separately for executable and archive", () => {
    const report = packageSizeReport([
        { scene: "growing", exeBytes: 2 ** 21, previousExeBytes: 2 ** 20, zipBytes: 2 ** 19, previousZipBytes: 2 ** 20 },
        { scene: "new", exeBytes: 123, zipBytes: 456, previousExeBytes: null, previousZipBytes: null },
    ]);
    assert.match(report, /growing \| 2\.00 \| \+1\.00 MiB \(100\.0%\) \| 0\.50 \| -0\.50 MiB \(-50\.0%\)/);
    assert.match(report, /new \| 0\.00 \| New \| 0\.00 \| New/);
});
