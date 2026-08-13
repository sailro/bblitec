import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { suiteBrowserModule } from "../src/capture-suite-reference.js";
import {
    scenes,
} from "../src/scene-registry.js";
import { readUpstreamPin } from "../src/upstream-source.js";

interface CorpusSceneEntry {
    id: string;
    upstreamPath: string;
    source: string;
    sha256: string;
}

interface CorpusModuleEntry {
    upstreamPath: string;
    source: string;
    sha256: string;
}

interface CorpusSceneManifest {
    package: string;
    version: string;
    sourceVersion: string;
    scenes: CorpusSceneEntry[];
    modules?: CorpusModuleEntry[];
}

interface CorpusReferenceEntry {
    id: string;
    sourceSha256: string;
    reference: string;
    referenceSha256: string;
    moduleSha256: string;
}

interface CorpusReferenceManifest {
    sourceVersion: string;
    scenes: CorpusReferenceEntry[];
}

function corpusManifest(): CorpusSceneManifest {
    const value: unknown = JSON.parse(
        readFileSync(
            "upstream/babylon-lite-scenes.json",
            "utf8",
        ),
    );
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
    ) {
        throw new Error("Invalid corpus scene manifest.");
    }
    const manifest = value as Partial<CorpusSceneManifest>;
    if (
        typeof manifest.package !== "string" ||
        typeof manifest.version !== "string" ||
        typeof manifest.sourceVersion !== "string" ||
        !Array.isArray(manifest.scenes)
    ) {
        throw new Error("Incomplete corpus scene manifest.");
    }
    return manifest as CorpusSceneManifest;
}

test("keeps registered Babylon Lite scenes byte-identical to the pin", () => {
    const manifest = corpusManifest();
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

test("keeps registered Babylon Lite demo modules byte-identical to the pin", () => {
    const manifest = corpusManifest();
    for (const module of manifest.modules ?? []) {
        assert.match(
            module.upstreamPath,
            /^lab\/lite\/src\/demos\//,
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
    const sources = corpusManifest();
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
                    scene.parity.referenceFrameRate,
                    scene.parity
                        .referenceAnimationGroups,
                ),
            )
            .digest("hex");
        assert.equal(
            moduleDigest,
            reference.moduleSha256,
            `${reference.id} capture module differs from golden provenance.`,
        );
    }
});
