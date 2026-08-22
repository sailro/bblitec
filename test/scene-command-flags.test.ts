import assert from "node:assert/strict";
import test from "node:test";
import {
    backendFileToken,
    canonicalBackend,
    flagNumber,
    parseFlags,
    parseParityArguments,
    resolveBackend,
} from "../src/parity-scene.js";

// The strict parser every scene subcommand shares. These are the
// behaviors that were each a silent failure before it existed: an
// unknown flag ran the tool with defaults, `--differential` dropped its
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

test("canonicalizes backend values, accepting 'gpu' for sdl_gpu", () => {
    assert.equal(
        canonicalBackend("gpu", "capture"),
        "sdl_gpu",
    );
    assert.equal(
        canonicalBackend("dawn", "capture"),
        "dawn",
    );
    assert.throws(
        () => canonicalBackend("vulkan", "capture"),
        /--backend must be sdl_gpu\|dawn \(got 'vulkan'\)/,
    );
});

test("spells sdl_gpu as 'gpu' in artifact filenames", () => {
    // One token per backend across parity, capture, diff and geometry:
    // `gpu` stays the SDL_GPU filename token for continuity with the
    // parity artifacts, while `--backend` values stay sdl_gpu|dawn.
    assert.equal(backendFileToken("sdl_gpu"), "gpu");
    assert.equal(backendFileToken("dawn"), "dawn");
});

test("resolves the backend from the flag, the ambient variable, then the default", () => {
    const previous = process.env.BBLITE_GPU_BACKEND;
    try {
        delete process.env.BBLITE_GPU_BACKEND;
        assert.equal(
            resolveBackend(undefined, "diff"),
            "sdl_gpu",
        );
        // The ambient variable is the fallback — the case that used to
        // silently measure sdl_gpu under BBLITE_GPU_BACKEND=dawn.
        process.env.BBLITE_GPU_BACKEND = "dawn";
        assert.equal(
            resolveBackend(undefined, "diff"),
            "dawn",
        );
        // An explicit flag wins over the ambient variable.
        assert.equal(
            resolveBackend("sdl_gpu", "diff"),
            "sdl_gpu",
        );
        assert.equal(
            resolveBackend("gpu", "diff"),
            "sdl_gpu",
        );
    } finally {
        if (previous === undefined) {
            delete process.env.BBLITE_GPU_BACKEND;
        } else {
            process.env.BBLITE_GPU_BACKEND = previous;
        }
    }
});

test("parses the parity flag set", () => {
    const parsed = parseParityArguments([
        "scene33",
        "--backend",
        "gpu",
        "--seek",
        "1.5",
        "--recapture-reference",
    ]);
    assert.equal(parsed.sceneId, "scene33");
    assert.equal(parsed.backend, "sdl_gpu");
    assert.equal(parsed.seekSeconds, 1.5);
    assert.ok(parsed.recaptureReference);
    assert.ok(!parsed.differential);
});

test("refuses the deleted CPU backend selection", () => {
    // bblitec requires a GPU: there is no SDL_Renderer fallback to
    // measure, so the flag that selected one is an error rather than a
    // silently ignored no-op.
    assert.throws(
        () => parseParityArguments(["--cpu"]),
        /Unknown parity argument '--cpu'/,
    );
    assert.throws(
        () => parseParityArguments(["--backend", "cpu"]),
        /--backend must be sdl_gpu\|dawn/,
    );
});

test("rejects the deleted --gpu no-op and unknown parity flags", () => {
    assert.throws(
        () => parseParityArguments(["--gpu"]),
        /Unknown parity argument '--gpu'/,
    );
});

test("refuses --differential with --recapture-reference, naming the two-step workaround", () => {
    // Silently dropping the companion measured a stale golden with full
    // confidence; the error names the order that works.
    assert.throws(
        () =>
            parseParityArguments([
                "--differential",
                "--recapture-reference",
            ]),
        /--recapture-reference.*then run 'scene -- parity <id> --differential'/s,
    );
});

test("refuses --differential with any companion it would drop", () => {
    assert.throws(
        () => parseParityArguments(["--differential", "--seek", "2"]),
        /--differential measures both GPU backends.*--seek/,
    );
    assert.throws(
        () =>
            parseParityArguments(["--differential", "--backend", "dawn"]),
        /--differential measures both GPU backends.*--backend/,
    );
    // --gpu-debug is the one companion the differential carries.
    assert.ok(
        parseParityArguments(["--differential", "--gpu-debug"]).gpuDebug,
    );
});
