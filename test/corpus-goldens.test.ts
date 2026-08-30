import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
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
