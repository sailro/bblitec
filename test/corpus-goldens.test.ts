import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { scenes } from "../src/scene-registry.js";
import { readBabylonLiteCorpus } from "../src/upstream-corpus.js";
import { readUpstreamPin } from "../src/upstream-source.js";

const manifest = readBabylonLiteCorpus();

function sha256(path: string): string {
    return createHash("sha256")
        .update(readFileSync(resolve(path)))
        .digest("hex");
}

test("keeps external golden applications byte-identical to their manifests", () => {
    assert.deepEqual(
        {
            package: manifest.package,
            version: manifest.version,
            sourceVersion: manifest.sourceVersion,
        },
        readUpstreamPin(),
    );
    assert.match(manifest.repository, /^https:\/\//);
    const ids = new Set<string>();
    for (const application of manifest.applications) {
        assert.ok(!ids.has(application.id), `Duplicate golden '${application.id}'.`);
        ids.add(application.id);
        assert.ok(
            application.files.some(({ source }) => source === application.entry),
            `${application.id} entry is not part of its immutable file set.`,
        );

        const paths = new Set<string>();
        for (const file of application.files) {
            assert.ok(
                !paths.has(file.source),
                `${application.id} repeats '${file.source}'.`,
            );
            paths.add(file.source);
            if (file.origin !== undefined) {
                assert.match(
                    file.origin,
                    /^https:\/\//,
                    `${file.upstreamPath} names an origin that is not a URL.`,
                );
            }
            assert.equal(
                sha256(file.source),
                file.sha256,
                `${file.upstreamPath} differs from its recorded upstream bytes.`,
            );
        }
        assert.equal(
            sha256(application.reference.source),
            application.reference.sha256,
            `${application.id} reference image differs from its recorded bytes.`,
        );
    }

    const registered = scenes.filter(
        ({ sourceOrigin }) => sourceOrigin === "babylon-lite-application",
    );
    assert.deepEqual(
        registered.map(({ id }) => id).sort(),
        [...ids].sort(),
    );
    for (const application of manifest.applications) {
        const scene = registered.find(({ id }) => id === application.id);
        assert.equal(scene?.source, application.entry);
        assert.equal(scene?.parity?.reference.path, application.reference.source);
    }
});

/**
 * The pin's own LWR proof gate, replayed over this port's two goldens.
 *
 * Scenes 200 and 201 are one measurement of a flag, not two of a scene:
 * they differ in exactly one thing -- `useHighPrecisionMatrix` and
 * `useFloatingOrigin` off against on -- and `tests/lite/unit/
 * hpm-divergence.test.ts` upstream asserts what that difference has to look
 * like. Each scene's own parity gate says the port matches the browser;
 * only this says the two are not the same picture, which is the failure
 * that would leave both gates passing while the precision path did nothing.
 *
 * Both of the pin's guards are kept, because they catch different things:
 * a golden that is only clear colour means the HPM path drew nothing (the
 * blank-render regression its comment names), and a cross-golden MAD at or
 * under 1.0 means the offset is being undone downstream.
 */
const HPM_CLEAR_COLOUR = [13, 13, 20] as const;

/** The pin's own window MAD: the mean over RGB, per pixel, full image. */
function crossGoldenMad(
    first: Buffer,
    second: Buffer,
): { mad: number; maxDiff: number } {
    const a = PNG.sync.read(first);
    const b = PNG.sync.read(second);
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    let sum = 0;
    let maxDiff = 0;
    for (let index = 0; index < a.data.length; index += 4) {
        let pixelSum = 0;
        for (let channel = 0; channel < 3; channel += 1) {
            const difference = Math.abs(
                a.data[index + channel]! - b.data[index + channel]!,
            );
            pixelSum += difference;
            if (difference > maxDiff) maxDiff = difference;
        }
        sum += pixelSum / 3;
    }
    return { mad: sum / (a.width * a.height), maxDiff };
}

/** The pin's non-blank guard: at least 1% of pixels left the clear colour. */
function drawnFraction(png: Buffer): number {
    const image = PNG.sync.read(png);
    let drawn = 0;
    for (let index = 0; index < image.data.length; index += 4) {
        const off = HPM_CLEAR_COLOUR.some(
            (channel, offset) =>
                Math.abs(image.data[index + offset]! - channel) > 8,
        );
        if (off) drawn += 1;
    }
    return drawn / (image.width * image.height);
}

test("keeps the high-precision-matrix pair diverging", () => {
    const off = readFileSync(
        resolve("reference/scene200/babylon-lite-golden.png"),
    );
    const on = readFileSync(
        resolve("reference/scene201/babylon-lite-golden.png"),
    );
    for (const [label, golden] of [
        ["scene200 (HPM off)", off],
        ["scene201 (HPM on)", on],
    ] as const) {
        assert.ok(
            drawnFraction(golden) > 0.01,
            `${label} golden is almost entirely clear colour, so the ` +
                "precision path drew nothing.",
        );
    }
    const { mad, maxDiff } = crossGoldenMad(off, on);
    assert.ok(
        mad > 1.0,
        `scenes 200 and 201 differ by MAD ${mad.toFixed(3)} (max ` +
            `${maxDiff}), at or under the pin's own 1.0 gate: the ` +
            "high-precision-matrix flag is not changing what is drawn.",
    );
});
