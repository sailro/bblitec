import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { suiteBrowserModule } from "../src/capture-suite-reference.js";
import {
    getScene,
    scenes,
} from "../src/scene-registry.js";
import { compareImages, compareRegion } from "../src/parity.js";
import { readUpstreamPin } from "../src/upstream-source.js";
import { readBabylonLiteCorpus } from "../src/upstream-corpus.js";

interface CorpusReferenceEntry {
    id: string;
    sourceSha256: string;
    reference: string;
    referenceSha256: string;
    moduleSha256: string;
    /**
     * The query the reference page was served at, for a scene whose own
     * pinned spec serves one. The module digest cannot carry it -- the
     * query is a navigation parameter, not module text -- so a golden
     * captured bare and one captured at a pose would otherwise share a
     * provenance.
     */
    referenceSearch?: string;
}

interface CorpusReferenceManifest {
    sourceVersion: string;
    scenes: CorpusReferenceEntry[];
}

test("keeps registered Babylon Lite scenes byte-identical to the pin", () => {
    const manifest = readBabylonLiteCorpus();
    const pin = readUpstreamPin();
    assert.deepEqual(
        {
            package: manifest.package,
            version: manifest.version,
            sourceVersion: manifest.sourceVersion,
        },
        pin,
    );

    const entries = new Map(
        manifest.scenes.map((entry) => [
            entry.id,
            entry,
        ]),
    );
    const registered = scenes.filter(({ id }) =>
        /^scene\d+$/.test(id),
    );
    assert.deepEqual(
        [...entries.keys()].sort(),
        registered.map(({ id }) => id).sort(),
    );

    for (const scene of registered) {
        const entry = entries.get(scene.id);
        assert.ok(entry, `Missing corpus entry for ${scene.id}.`);
        assert.equal(scene.source, entry.source);
        assert.match(
            entry.upstreamPath,
            new RegExp(
                `^lab/lite/src/lite/${scene.id}\\.ts$`,
            ),
        );
        const bytes = readFileSync(entry.source);
        const digest = createHash("sha256")
            .update(bytes)
            .digest("hex");
        assert.equal(
            digest,
            entry.sha256,
            `${scene.id} input differs from pinned upstream evidence.`,
        );
    }
});

test("keeps registered Babylon Lite support modules byte-identical to the pin", () => {
    const manifest = readBabylonLiteCorpus();
    for (const module of manifest.modules ?? []) {
        assert.match(
            module.upstreamPath,
            /^lab\/lite\/src\/(?:demos|shared|_shared)\//,
        );
        assert.equal(
            module.source,
            `corpus/babylon-lite/${module.upstreamPath}`,
        );
        const digest = createHash("sha256")
            .update(readFileSync(module.source))
            .digest("hex");
        assert.equal(
            digest,
            module.sha256,
            `${module.upstreamPath} input differs from pinned upstream evidence.`,
        );
    }
});

test("keeps exact-source corpus references immutable", () => {
    const sources = readBabylonLiteCorpus();
    const value: unknown = JSON.parse(
        readFileSync(
            "reference/exact-corpus-manifest.json",
            "utf8",
        ),
    );
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
    ) {
        throw new Error(
            "Invalid corpus reference manifest.",
        );
    }
    const references =
        value as CorpusReferenceManifest;
    assert.equal(
        references.sourceVersion,
        sources.sourceVersion,
    );
    const sourceEntries = new Map(
        sources.scenes.map((entry) => [
            entry.id,
            entry,
        ]),
    );
    assert.deepEqual(
        references.scenes.map(({ id }) => id).sort(),
        [...sourceEntries.keys()].sort(),
    );
    for (const reference of references.scenes) {
        assert.equal(
            reference.sourceSha256,
            sourceEntries.get(reference.id)?.sha256,
        );
        const digest = createHash("sha256")
            .update(readFileSync(reference.reference))
            .digest("hex");
        assert.equal(
            digest,
            reference.referenceSha256,
            `${reference.id} golden differs from exact-source evidence.`,
        );
        const scene = scenes.find(
            ({ id }) => id === reference.id,
        );
        assert.ok(scene?.parity);
        assert.equal(
            reference.reference,
            scene.parity.reference.path,
        );
        const moduleDigest = createHash("sha256")
            .update(
                suiteBrowserModule(
                    scene.source,
                    undefined,
                    scene.parity.referenceTimeSeconds,
                    scene.parity
                        .referenceAnimationGroups,
                    scene.parity.referenceFrame,
                ),
            )
            .digest("hex");
        assert.equal(
            moduleDigest,
            reference.moduleSha256,
            `${reference.id} capture module differs from golden provenance.`,
        );
        assert.equal(
            reference.referenceSearch,
            scene.parity.referenceSearch,
            `${reference.id} capture query differs from golden provenance.`,
        );
    }
});

/**
 * The pin's own LWR proof gate, replayed over this port's two goldens.
 *
 * Scenes 200 and 201 are one measurement of a flag, not two of a scene:
 * they differ in exactly one thing -- `useHighPrecisionMatrix` and
 * `useFloatingOrigin` off against on -- and
 * `tests/lite/unit/hpm-divergence.test.ts` upstream asserts what that
 * difference has to look like. Each scene's own parity gate says the port
 * matches the browser; only this says the two are not the same picture,
 * which is the failure that would leave both gates passing while the
 * precision path did nothing.
 *
 * Both of the pin's guards are kept, because they catch different things:
 * a golden that is only clear colour means the HPM path drew nothing (the
 * blank-render regression its comment names), and a cross-golden MAD at or
 * under 1.0 means the offset is being undone downstream. Each is measured
 * through the parity module the scene gates themselves use -- `compareImages`
 * is already the pin's own metric, the mean over RGB per pixel over the
 * whole image -- and against the background each scene's registry entry
 * declares rather than a second copy of that colour.
 */
test("keeps the high-precision-matrix pair diverging", () => {
    const gateOf = (id: string) => {
        const gate = getScene(id).parity;
        assert.ok(gate, `${id} must carry a parity gate.`);
        return gate;
    };
    const off = gateOf("scene200");
    const on = gateOf("scene201");
    for (const gate of [off, on]) {
        // `compareRegion` classifies against the registry's own background,
        // so an image compared with itself counts the pixels that left it:
        // the pin's non-blank guard, at this repo's own threshold.
        const drawn = compareRegion(
            gate.reference.path,
            gate.reference.path,
            gate.backgroundColor,
            gate.backgroundThreshold,
        );
        assert.ok(
            drawn.regionPixels / drawn.totalPixels > 0.01,
            `${gate.reference.path} is almost entirely background, so the ` +
                "precision path drew nothing.",
        );
    }
    const { mad, maxDiff } = compareImages(
        off.reference.path,
        on.reference.path,
    );
    assert.ok(
        mad > 1.0,
        `scenes 200 and 201 differ by MAD ${mad.toFixed(3)} (max ` +
            `${maxDiff}), at or under the pin's own 1.0 gate: the ` +
            "high-precision-matrix flag is not changing what is drawn.",
    );
});
