import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { mobilePackageArguments } from "../src/shipping-mobile.js";
import {
    androidCaptureSettings,
    verifyAndroidNativeRun,
} from "../src/android-capture.js";
import { resolveScene } from "../src/scene-registry.js";

test("Android canvas-only capture changes pixels, not the registered pose or frame budget", () => {
    const scene = resolveScene("tetris");
    const original = structuredClone(scene.parity?.nativeEnvironment);
    const full = androidCaptureSettings(scene);
    const canvas = androidCaptureSettings(scene, { canvasOnly: true });
    const expected: typeof canvas = {
        captureFrame: full.captureFrame,
        captureEnvironment: {
            ...full.captureEnvironment,
            BBLITE_CAPTURE_UI: "0",
        },
    };
    assert.deepEqual(canvas, expected);
    assert.equal(canvas.captureEnvironment.BBLITE_TEST_PASS, "1");
    assert.equal(
        Number(canvas.captureEnvironment.BBLITE_MAX_FRAMES),
        Number(canvas.captureFrame) + 1,
    );
    assert.equal(canvas.captureEnvironment.BBLITE_SCREENSHOT_FRAME, undefined);
    assert.deepEqual(scene.parity?.nativeEnvironment, original);
    assert.deepEqual(androidCaptureSettings(undefined), {
        captureFrame: "5",
        captureEnvironment: {
            BBLITE_MAX_FRAMES: "8",
            BBLITE_TEST_PASS: "1",
            BBLITE_GPU_BACKEND: "sdl_gpu",
        },
    });
    assert.deepEqual(androidCaptureSettings(undefined, { canvasOnly: true }), {
        captureFrame: "5",
        captureEnvironment: {
            BBLITE_MAX_FRAMES: "8",
            BBLITE_TEST_PASS: "1",
            BBLITE_GPU_BACKEND: "sdl_gpu",
            BBLITE_CAPTURE_UI: "0",
        },
    });
    const activity = readFileSync(
        "native/android/app/src/main/java/org/bblite/prototype/MainActivity.java",
        "utf8",
    );
    assert.match(
        activity,
        /FLAG_DEBUGGABLE[\s\S]*"BBLITE_CAPTURE_UI"[\s\S]*nativeSetenv\(key, value\)/,
    );
});

test("Android capture selects either backend without changing registered poses", () => {
    for (const id of ["scene1", "torus-states", "offscreen"]) {
        const scene = resolveScene(id);
        const sdl = androidCaptureSettings(scene);
        const dawn = androidCaptureSettings(scene, { backend: "dawn" });
        assert.deepEqual(dawn, {
            captureFrame: sdl.captureFrame,
            captureEnvironment: {
                ...sdl.captureEnvironment,
                BBLITE_GPU_BACKEND: "dawn",
            },
        });
    }
});

test("Android smoke requires the requested backend and one successful exit for the current run", () => {
    for (const backend of ["sdl_gpu", "dawn"] as const) {
        const selected = `I bblite: GPU backend: ${backend} run=current\n`;
        const exit = "I bblite: Native exit: 0 run=current\n";
        verifyAndroidNativeRun(selected + exit, "current", backend);
        verifyAndroidNativeRun(
            `GPU backend: other run=old\nNative exit: 1 run=old\n${selected}${exit}`,
            "current",
            backend,
        );
        for (const log of [
            exit,
            selected + selected + exit,
            selected.replace(backend, "other") + exit,
            selected.replace("current", "stale") + exit,
        ]) {
            assert.throws(
                () => verifyAndroidNativeRun(log, "current", backend),
                /did not select/,
            );
        }
        for (const log of [
            selected,
            selected + exit + exit,
            selected + exit.replace("current", "stale"),
        ]) {
            assert.throws(
                () => verifyAndroidNativeRun(log, "current", backend),
                /one native exit/,
            );
        }
        for (const status of ["1", "-1"]) {
            assert.throws(
                () =>
                    verifyAndroidNativeRun(
                        selected + exit.replace(": 0", `: ${status}`),
                        "current",
                        backend,
                    ),
                /status/,
            );
        }
    }
});

const cmake = discoverDevelopmentTools().cmake;
test(
    "Android sweep installs only dependencies reached by its selected scenes",
    { skip: !cmake },
    (t) => {
        mkdirSync("artifacts", { recursive: true });
        const directory = mkdtempSync(
            resolve("artifacts/android-sweep-dependencies-"),
        );
        assert.equal(dirname(directory), resolve("artifacts"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const scenes = [
            join(directory, "first scene"),
            join(directory, "second scene"),
        ];
        for (const scene of scenes) mkdirSync(scene);
        const sourceList = join(directory, "directories.txt");
        const output = join(directory, "dependencies.txt");
        writeFileSync(
            sourceList,
            scenes.map((scene) => scene.replaceAll("\\", "/")).join("\n"),
        );
        const featureFile = (scene: string, runtime: string) =>
            writeFileSync(
                join(scene, "features.cmake"),
                `set(BBLITE_RUNTIME_FEATURES ${runtime})\nset(BBLITE_IMAGE_CODECS "")\n`,
            );
        const profile = () => {
            execFileSync(
                cmake!,
                [
                    `-DBBLITE_GENERATED_DIRS_FILE=${sourceList}`,
                    `-DBBLITE_PROFILE_OUTPUT=${output}`,
                    "-P",
                    "tools/scene-dependencies.cmake",
                ],
                { stdio: "pipe" },
            );
            return readFileSync(output, "utf8").trim().split(";");
        };
        featureFile(scenes[0]!, "physics:world");
        featureFile(scenes[1]!, "physics:world text:layout");
        // Android links vcpkg's SDL: every profile requests it.
        assert.deepEqual(profile(), ["physics", "png", "sdl", "text-layout"]);
        featureFile(scenes[0]!, "data:locale platform:http");
        assert.deepEqual(profile(), [
            "http",
            "locale",
            "physics",
            "png",
            "sdl",
            "text-layout",
        ]);
        featureFile(scenes[0]!, "ui:rml audio:engine");
        featureFile(scenes[1]!, "ui:rml platform:window");
        assert.deepEqual(profile(), ["png", "sdl", "ui", "ui-svg"]);
    },
);

test("Android packaging passes the requested target and keeps shared work serialized", () => {
    const values = new Map([
        ["--abi", "x86_64"],
        ["--sdk", "C:/SDK with spaces"],
        ["--device", "emulator-5554"],
        ["--jobs", "3"],
        ["--workers", "1"],
        ["--backend", "dawn"],
    ]);
    const args = mobilePackageArguments("android", "torus-states", values);
    assert.equal(
        args[args.indexOf("-File") + 1],
        resolve("tools/package-android.ps1"),
    );
    for (const [flag, expected] of [
        ["-Scene", "torus-states"],
        ["-Abi", "x86_64"],
        ["-Sdk", "C:/SDK with spaces"],
        ["-Device", "emulator-5554"],
        ["-Jobs", "3"],
        ["-Backend", "DAWN"],
    ]) {
        assert.equal(args[args.indexOf(flag!) + 1], expected);
    }
    assert.throws(
        () =>
            mobilePackageArguments(
                "android",
                "torus-states",
                new Map([["--abi", "x86"]]),
            ),
        /ABI/,
    );
    assert.throws(
        () =>
            mobilePackageArguments(
                "android",
                "torus-states",
                new Map([["--jobs", "0"]]),
            ),
        /positive/,
    );
    assert.throws(
        () =>
            mobilePackageArguments(
                "android",
                "torus-states",
                new Map([["--workers", "2"]]),
            ),
        /share dependencies/,
    );
    const defaults = mobilePackageArguments(
        "android",
        "torus-states",
        new Map(),
    );
    assert.equal(defaults[defaults.indexOf("-Backend") + 1], "SDL_GPU");
    for (const backend of ["both", "vulkan", ""]) {
        assert.throws(
            () =>
                mobilePackageArguments(
                    "android",
                    "torus-states",
                    new Map([["--backend", backend]]),
                ),
            /backend/,
        );
    }
    assert.throws(
        () =>
            mobilePackageArguments(
                "ios",
                "torus-states",
                new Map([["--backend", "dawn"]]),
            ),
        /backend/,
    );
});
