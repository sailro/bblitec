import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { scenes } from "../src/scene-registry.js";
import { readBabylonLiteCorpus } from "../src/upstream-corpus.js";
import { readUpstreamPin } from "../src/upstream-source.js";
import {
    suiteBrowserModuleDigest,
    pinnedBrowserEntryUrl,
} from "../src/capture-suite-reference.js";
import { engineFrameCaptureModule } from "../src/capture-engine-frames.js";

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
        assert.ok(
            !ids.has(application.id),
            `Duplicate golden '${application.id}'.`,
        );
        ids.add(application.id);
        assert.ok(
            application.files.some(
                ({ source }) => source === application.entry,
            ),
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
        const provenance = application.reference.provenance;
        if (provenance !== undefined) {
            assert.equal(
                sha256(provenance.source),
                provenance.sha256,
                `${application.id} capture provenance differs from its recorded bytes.`,
            );
        }
    }

    const registered = scenes.filter(
        ({ sourceOrigin }) => sourceOrigin === "babylon-lite-application",
    );
    assert.deepEqual(registered.map(({ id }) => id).sort(), [...ids].sort());
    for (const application of manifest.applications) {
        const scene = registered.find(({ id }) => id === application.id);
        assert.equal(scene?.source, application.entry);
        assert.equal(
            scene?.parity?.reference.path,
            application.reference.source,
        );
        const capture = application.reference.capture;
        if (scene?.parity?.independentEngines !== undefined) {
            assert.ok(
                capture,
                `${application.id} needs independent-engine capture provenance.`,
            );
            assert.equal(capture.frame, scene.parity.referenceFrame);
            assert.equal(
                capture.independentEngines,
                scene.parity.independentEngines,
            );
            assert.equal(capture.hostPage, scene.parity.referenceHostPage);
            assert.equal(capture.hostPageSha256, sha256(capture.hostPage));
            assert.equal(
                capture.moduleSha256,
                suiteBrowserModuleDigest(
                    scene.source,
                    undefined,
                    undefined,
                    capture.frame,
                    capture.independentEngines,
                ),
            );
            assert.equal(
                capture.adapterSha256,
                createHash("sha256")
                    .update(
                        engineFrameCaptureModule(
                            capture.frame,
                            pinnedBrowserEntryUrl,
                        ),
                    )
                    .digest("hex"),
            );
        }
    }
});

test("Ocean reference preserves the pinned frozen pose and reached source graph", () => {
    const application = manifest.applications.find(({ id }) => id === "ocean");
    const scene = scenes.find(({ id }) => id === "ocean");
    assert.ok(application?.reference.provenance);
    assert.ok(scene?.parity);
    const provenance = JSON.parse(
        readFileSync(application.reference.provenance.source, "utf8"),
    ) as {
        pin: ReturnType<typeof readUpstreamPin>;
        reference: { source: string; sha256: string };
        entry: string;
        hostPage: string;
        pose: {
            search: string;
            width: number;
            height: number;
            dpr: number;
            referenceFrame: number;
        };
        readiness: Record<string, string>;
        browser: { showScrollbars?: boolean };
        moduleSha256: string;
        sourceFiles: Array<{ path: string; sha256: string }>;
    };
    assert.deepEqual(provenance.pin, readUpstreamPin());
    assert.equal(provenance.entry, scene.source);
    assert.equal(provenance.hostPage, scene.parity.referenceHostPage);
    assert.equal(scene.nativeHostUi, "ui/ocean-host.json");
    assert.equal(scene.parity.referenceScrollbars, true);
    assert.equal(provenance.browser.showScrollbars, true);
    assert.deepEqual(provenance.pose, {
        search: "?seekTime=0.1",
        width: 1280,
        height: 720,
        dpr: 1,
        referenceFrame: 30,
    });
    assert.equal(scene.parity.referenceSearch, provenance.pose.search);
    assert.equal(scene.parity.referenceFrame, provenance.pose.referenceFrame);
    assert.equal(provenance.readiness.ready, "true");
    assert.equal(provenance.readiness.oceanStage, "complete");
    assert.equal(provenance.readiness.animationFrozen, "true");
    assert.equal(provenance.readiness.seekWarmupFrames, "6");
    assert.equal(provenance.readiness.seekWarmupMode, "compute-only");
    assert.equal(provenance.readiness.fixedCaptureFrame, "30");
    assert.equal(provenance.reference.source, application.reference.source);
    assert.equal(provenance.reference.sha256, application.reference.sha256);
    assert.equal(
        provenance.moduleSha256,
        suiteBrowserModuleDigest(
            scene.source,
            undefined,
            undefined,
            scene.parity.referenceFrame,
        ),
    );
    assert.deepEqual(
        provenance.sourceFiles,
        application.files.map(({ source, sha256 }) => ({
            path: source,
            sha256,
        })),
    );
});

test("Playroom reference retains its unchanged host, source graph and capture pose", () => {
    const application = manifest.applications.find(({ id }) => id === "playroom");
    const scene = scenes.find(({ id }) => id === "playroom");
    assert.ok(application?.reference.provenance);
    assert.ok(scene?.parity);
    const provenance = JSON.parse(readFileSync(application.reference.provenance.source, "utf8")) as {
        pin: ReturnType<typeof readUpstreamPin>;
        entry: string;
        hostPage: string;
        hostPageSha256: string;
        reference: {source: string; sha256: string};
        pose: {search: string; width: number; height: number; dpr: number; referenceFrame: number; seededRandom: boolean};
        moduleSha256: string;
        sourceFiles: Array<{path: string; sha256: string}>;
    };
    assert.deepEqual(provenance.pin, readUpstreamPin());
    assert.equal(provenance.entry, scene.source);
    assert.equal(provenance.hostPage, scene.parity.referenceHostPage);
    assert.equal(provenance.hostPageSha256, sha256(provenance.hostPage));
    assert.equal(scene.nativeHostUi, "ui/playroom-host.json");
    assert.deepEqual(provenance.pose, {
        search: "", width: 1280, height: 720, dpr: 1,
        referenceFrame: scene.parity.referenceFrame, seededRandom: true,
    });
    assert.equal(provenance.reference.source, application.reference.source);
    assert.equal(provenance.reference.sha256, application.reference.sha256);
    assert.equal(provenance.moduleSha256, suiteBrowserModuleDigest(scene.source, undefined, undefined, scene.parity.referenceFrame));
    assert.deepEqual(provenance.sourceFiles, application.files.map(({source, sha256}) => ({path: source, sha256})));
});
