import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseParityArguments } from "../src/parity-scene.js";
import { flagNumber, parseFlags } from "../src/tooling/flags.js";
import {
    backendFileToken,
    canonicalBackend,
    measuredBackends,
    resolveBackend,
    resolvePose,
} from "../src/tooling/artifacts.js";
import { parseBackendName } from "../src/tooling/backends.js";

test("process exposes one normal deployment without a live mode", () => {
    const command = fileURLToPath(
        new URL("../src/scene-command.js", import.meta.url),
    );
    const help = spawnSync(process.execPath, [command, "help"], {
        encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /--live/);
    const live = spawnSync(
        process.execPath,
        [command, "process", "ocean", "--live", "--backend", "both"],
        { encoding: "utf8" },
    );
    assert.equal(live.status, 1);
    assert.match(live.stderr, /Unknown process argument '--live'/);
});

// The strict parser every scene subcommand shares. These are the
// behaviors that were each a silent failure before it existed: an
// unknown flag ran the tool with defaults, a mode dropped its
// companions, and the same backend had two artifact spellings.

test("parses value flags, boolean flags, aliases and positionals", () => {
    const parsed = parseFlags(
        ["scene33", "--backend", "dawn", "--recapture", "--out", "somewhere"],
        {
            value: ["--backend", "--capture"],
            boolean: ["--recapture"],
            alias: { "--out": "--capture" },
            positionals: 1,
        },
        "diff",
    );
    assert.deepEqual(parsed.positionals, ["scene33"]);
    assert.equal(parsed.values.get("--backend"), "dawn");
    // The alias lands under its canonical name.
    assert.equal(parsed.values.get("--capture"), "somewhere");
    assert.ok(parsed.flags.has("--recapture"));
});

test("rejects an unknown flag, naming the valid set", () => {
    // `diff --recapture-reference` — the typo the twin names invite —
    // was a silent no-op before the strict parser.
    assert.throws(
        () =>
            parseFlags(
                ["--recapture-reference"],
                { boolean: ["--recapture"], value: ["--backend"] },
                "diff",
            ),
        /Unknown diff argument '--recapture-reference'.*--backend.*--recapture/,
    );
});

test("rejects a value flag with no value and an extra positional", () => {
    assert.throws(
        () => parseFlags(["--seek"], { value: ["--seek"] }, "capture"),
        /--seek requires a value/,
    );
    assert.throws(
        () => parseFlags(["stray"], {}, "neutrality"),
        /Unexpected neutrality argument 'stray'/,
    );
});

test("flagNumber rejects a value that does not parse", () => {
    const parsed = parseFlags(
        ["--seek", "oops"],
        { value: ["--seek"] },
        "capture",
    );
    assert.throws(
        () => flagNumber(parsed, "--seek", "capture"),
        /--seek must be a number \(got 'oops'\)/,
    );
    assert.equal(
        flagNumber(
            parseFlags(["--seek", "2.5"], { value: ["--seek"] }, "capture"),
            "--seek",
            "capture",
        ),
        2.5,
    );
});

test("parses backend names case-insensitively, accepting 'gpu' for sdl_gpu", () => {
    assert.equal(canonicalBackend("gpu", "capture"), "sdl_gpu");
    assert.equal(canonicalBackend("SDL_GPU", "capture"), "sdl_gpu");
    assert.equal(canonicalBackend("sdl-gpu", "capture"), "sdl_gpu");
    assert.equal(canonicalBackend("Dawn", "capture"), "dawn");
    assert.throws(
        () => canonicalBackend("vulkan", "capture"),
        /capture: --backend must be sdl_gpu\|dawn \(got 'vulkan'\)/,
    );
    assert.throws(
        () => canonicalBackend("both", "capture"),
        /--backend must be sdl_gpu\|dawn \(got 'both'\)/,
    );
    assert.equal(parseBackendName("BOTH", "build: --backend", true), "both");
    assert.throws(
        () => parseBackendName("all", "build: --backend", true),
        /build: --backend must be sdl_gpu\|dawn\|both \(got 'all'\)/,
    );
});

test("spells sdl_gpu as 'gpu' in artifact filenames", () => {
    // One token per backend across parity, capture, diff and geometry:
    // `gpu` stays the SDL_GPU filename token for continuity with the
    // parity artifacts, while `--backend` values stay sdl_gpu|dawn.
    assert.equal(backendFileToken("sdl_gpu"), "gpu");
    assert.equal(backendFileToken("dawn"), "dawn");
});

/** Run `body` with the backend variables set as given, restoring them. */
function withBackendEnvironment(
    values: { gpu?: string; compiled?: string },
    body: () => void,
): void {
    const previous = {
        gpu: process.env.BBLITE_GPU_BACKEND,
        compiled: process.env.BBLITE_BACKEND,
    };
    const apply = (name: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    };
    try {
        apply("BBLITE_GPU_BACKEND", values.gpu);
        apply("BBLITE_BACKEND", values.compiled);
        body();
    } finally {
        apply("BBLITE_GPU_BACKEND", previous.gpu);
        apply("BBLITE_BACKEND", previous.compiled);
    }
}

test("resolves the backend from the flag, the ambient variable, then the default", () => {
    withBackendEnvironment({}, () => {
        assert.equal(resolveBackend(undefined, "diff"), "sdl_gpu");
    });
    withBackendEnvironment({ gpu: "dawn" }, () => {
        // The ambient variable is the fallback — the case that used to
        // silently measure sdl_gpu under BBLITE_GPU_BACKEND=dawn.
        assert.equal(resolveBackend(undefined, "diff"), "dawn");
        // An explicit flag wins over the ambient variable.
        assert.equal(resolveBackend("sdl_gpu", "diff"), "sdl_gpu");
        assert.equal(resolveBackend("gpu", "diff"), "sdl_gpu");
    });
    // Empty means unset, as it does natively.
    withBackendEnvironment({ gpu: "" }, () => {
        assert.equal(resolveBackend(undefined, "diff"), "sdl_gpu");
    });
});

test("refuses an ambient BBLITE_GPU_BACKEND the native runtime would reject", () => {
    // The executable accepts exactly sdl_gpu or dawn; coercing any other
    // value to sdl_gpu measured a backend nobody asked for.
    for (const value of ["Dawn", "vulkan", "gpu"]) {
        withBackendEnvironment({ gpu: value }, () => {
            assert.throws(
                () => resolveBackend(undefined, "diff"),
                new RegExp(
                    `BBLITE_GPU_BACKEND must be sdl_gpu or dawn \\(got '${value}'\\)`,
                ),
            );
            assert.throws(() => measuredBackends(undefined, "parity"));
        });
    }
});

test("measures the explicit selection, else the ambient one, else every compiled backend", () => {
    withBackendEnvironment({ compiled: "BOTH" }, () => {
        assert.deepEqual(measuredBackends(undefined, "parity"), [
            "sdl_gpu",
            "dawn",
        ]);
        assert.deepEqual(measuredBackends("dawn", "parity"), ["dawn"]);
        assert.deepEqual(measuredBackends("both", "parity"), [
            "sdl_gpu",
            "dawn",
        ]);
    });
    withBackendEnvironment({ compiled: "sdl_gpu" }, () => {
        assert.deepEqual(measuredBackends(undefined, "parity"), ["sdl_gpu"]);
    });
    withBackendEnvironment({ compiled: "BOTH", gpu: "dawn" }, () => {
        assert.deepEqual(measuredBackends(undefined, "parity"), ["dawn"]);
    });
});

test("resolves one pose rule for every seek site", () => {
    const seeked = { parity: { referenceTimeSeconds: 1.5 } };
    assert.deepEqual(resolvePose(seeked, undefined), {
        seekSeconds: 1.5,
        golden: true,
    });
    // An explicit seek equal to the registry's is the standard measurement.
    assert.deepEqual(resolvePose(seeked, 1.5), {
        seekSeconds: 1.5,
        golden: true,
    });
    assert.deepEqual(resolvePose(seeked, 0.25), {
        seekSeconds: 0.25,
        golden: false,
    });
    assert.deepEqual(resolvePose({}, undefined), {
        seekSeconds: undefined,
        golden: true,
    });
    assert.deepEqual(resolvePose({}, 2), { seekSeconds: 2, golden: false });
});

test("parses the parity flag set", () => {
    const parsed = parseParityArguments([
        "--backend",
        "GPU",
        "--seek",
        "1.5",
        "--no-fail",
    ]);
    assert.equal(parsed.backend, "sdl_gpu");
    assert.equal(parsed.seekSeconds, 1.5);
    assert.ok(parsed.noFail);
    assert.ok(!parsed.recaptureReference);
    assert.equal(parseParityArguments([]).backend, undefined);
    assert.equal(
        parseParityArguments(["--runs", "3", "--single-sample"]).runs,
        3,
    );
    assert.ok(parseParityArguments(["--geometry"]).geometry);
});

test("refuses the deleted parity flags", () => {
    // bblitec requires a GPU: there is no SDL_Renderer fallback to
    // measure, so the flag that selected one is an error rather than a
    // silently ignored no-op. Both backends are measured by default, so
    // the differential flag is gone too, and BBLITE_NATIVE_EXE replaced
    // the per-command executable flag.
    for (const flag of ["--cpu", "--gpu", "--differential", "--exe"]) {
        assert.throws(
            () => parseParityArguments([flag]),
            new RegExp(`Unknown parity argument '${flag}'`),
        );
    }
    assert.throws(
        () => parseParityArguments(["--backend", "cpu"]),
        /parity: --backend must be sdl_gpu\|dawn\|both \(got 'cpu'\)/,
    );
});

test("refuses parity flag combinations that would measure something else", () => {
    const refusals: Array<[string[], RegExp]> = [
        [
            ["--runs", "3", "--geometry"],
            /--runs and --geometry are separate modes/,
        ],
        [
            ["--geometry", "--attribute"],
            /--geometry and --attribute are separate modes/,
        ],
        [["--single-sample"], /--single-sample is a stability measurement/],
        [["--runs", "1"], /--runs must be an integer >= 2 \(got '1'\)/],
        [["--runs", "many"], /--runs must be an integer >= 2/],
        [
            ["--runs", "2", "--without", "ground"],
            /--runs does not compose with --without/,
        ],
        [
            ["--runs", "2", "--recapture-reference"],
            /--runs does not compose with --recapture-reference/,
        ],
        [
            ["--geometry", "--no-fail"],
            /--geometry does not compose with --no-fail/,
        ],
        [
            ["--attribute", "--without", "ground"],
            /--attribute does not compose with --without/,
        ],
        [
            ["--without", "ground", "--recapture-reference"],
            /--without does not compose with --recapture-reference/,
        ],
        [
            ["--without", "sky"],
            /--without must be ground\|background \(got 'sky'\)/,
        ],
        [
            ["--seek", "2", "--recapture-reference"],
            /--seek does not compose with --recapture-reference/,
        ],
        [
            ["--actual", "native.png"],
            /--actual measures one pre-rendered image/,
        ],
        [
            ["--actual", "native.png", "--backend", "both"],
            /--actual measures one pre-rendered image/,
        ],
    ];
    for (const [flags, message] of refusals) {
        assert.throws(
            () => parseParityArguments(flags),
            message,
            flags.join(" "),
        );
    }
    assert.equal(
        parseParityArguments(["--actual", "native.png", "--backend", "dawn"])
            .actual,
        "native.png",
    );
});
