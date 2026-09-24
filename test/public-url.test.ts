/**
 * A root-relative asset URL names the deployment's public files: the public
 * directory when one holds them, else the public URL that serves them. With
 * neither configured the URL names nothing and generation refuses it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assetRecord, resolveBundledAsset } from "../src/compiler/assets.js";
import {
    deploymentPublicAsset,
    deploymentPublicUrl,
} from "../src/compiler/deployment.js";
import { pinnedLabPublicUrl } from "../src/pinned-lab-public.js";

const textureScene = `
    import { createEngine, createSceneContext, loadTexture2D } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        createSceneContext(engine);
        const texture = await loadTexture2D(engine, "/textures/grass.png");
        console.log(texture);
    }
    main();
`;

test("a root-relative asset without public files refuses", () => {
    assert.throws(
        () => resolveBundledAsset("/textures/grass.png", "entry.ts"),
        /Root-relative asset '\/textures\/grass\.png' needs --public-dir or --public-url\./,
    );
    assert.throws(
        () => compileSource(textureScene, { fileName: "root-relative.ts" }),
        /Root-relative asset '\/textures\/grass\.png' needs --public-dir or --public-url\./,
    );
    const { manifest } = compileSource(textureScene, {
        fileName: "root-relative.ts",
        publicUrl: "https://cdn.example.invalid/public/",
    });
    assert.ok(
        manifest.assets.some(
            (asset) =>
                asset.source ===
                "https://cdn.example.invalid/public/textures/grass.png",
        ),
    );
});

test("a root-relative asset loads from beneath the public URL", () => {
    const options = { publicUrl: "https://cdn.example.invalid/public" };
    assert.equal(
        resolveBundledAsset("/textures/grass.png", "entry.ts", options),
        "https://cdn.example.invalid/public/textures/grass.png",
    );
    // Below a site base, the path beneath the base names the public file.
    const based = { ...options, siteUrl: "https://example.invalid/app/" };
    assert.equal(
        deploymentPublicAsset("/app/textures/grass.png", based),
        "https://cdn.example.invalid/public/textures/grass.png",
    );
    assert.equal(deploymentPublicAsset("/elsewhere.png", based), undefined);
    assert.throws(
        () => resolveBundledAsset("/elsewhere.png", "entry.ts", based),
        /needs --public-dir or --public-url/,
    );
    for (const invalid of [
        "cdn.example.invalid/public",
        "file:///public/",
        "https://cdn.example.invalid/public/?token=1",
    ])
        assert.throws(() => deploymentPublicUrl(invalid), /public URL/);
});

// Generation records one asset the compiler never saw -- a node-particle
// graph's texture, resolved by the pin against the scene's textureBaseUrl --
// and a root-relative one names the same public files a scene URL does.
test("a generation-time texture record resolves through the deployment", () => {
    assert.throws(
        () => assetRecord("/textures/flare.png", "texture", new Map()),
        /Root-relative asset '\/textures\/flare\.png' needs --public-dir or --public-url\./,
    );
    const asset = assetRecord("/textures/flare.png", "texture", new Map(), {
        entryFileName: "entry.ts",
        deployment: { publicUrl: "https://cdn.example.invalid/public/" },
    });
    assert.equal(
        asset.source,
        "https://cdn.example.invalid/public/textures/flare.png",
    );
    assert.match(asset.output, /^[0-9a-f]{8}-flare\.png$/);
});

test("the public directory answers before the public URL", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-public-url-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const publicDir = join(directory, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "grass.png"), "");
    assert.equal(
        resolveBundledAsset("/grass.png", join(directory, "entry.ts"), {
            publicDir,
            publicUrl: "https://cdn.example.invalid/public/",
        }),
        join(publicDir, "grass.png"),
    );
});

test("registry scenes load root-relative assets from the pinned lab public files", () => {
    assert.match(
        pinnedLabPublicUrl(),
        /^https:\/\/raw\.githubusercontent\.com\/BabylonJS\/Babylon-Lite\/[0-9a-f]{40}\/lab\/public\/$/,
    );
    assert.equal(
        resolveBundledAsset("/textures/grass.png", "entry.ts", {
            publicUrl: pinnedLabPublicUrl(),
        }),
        `${pinnedLabPublicUrl()}textures/grass.png`,
    );
});
