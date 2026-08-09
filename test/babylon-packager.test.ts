import assert from "node:assert/strict";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { packageBabylon } from "../src/babylon-packager.js";

test("packages Babylon scene textures beside rewritten JSON", async () => {
    const root = resolve(".cache/babylon-packager-test");
    const sourceDirectory = resolve(root, "source");
    const destination = resolve(root, "output/scene/scene.babylon");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(resolve(sourceDirectory, "diffuse image.jpg"), "texture");
    for (const suffix of ["_px", "_nx", "_py", "_ny", "_pz", "_nz"]) {
        writeFileSync(resolve(sourceDirectory, `cube${suffix}.jpg`), suffix);
    }
    writeFileSync(
        resolve(sourceDirectory, "scene.babylon"),
        JSON.stringify({
            materials: [
                {
                    id: "material",
                    diffuseTexture: {
                        name: "diffuse image.jpg",
                        isCube: false,
                    },
                    reflectionTexture: {
                        name: "cube",
                        isCube: true,
                    },
                },
            ],
            meshes: [],
        }),
    );

    try {
        await packageBabylon("scene.babylon", sourceDirectory, destination);
        const document = JSON.parse(readFileSync(destination, "utf8")) as {
            materials: Array<{
                diffuseTexture: { name: string };
                reflectionTexture: { name: string };
            }>;
        };
        const textureName = document.materials[0]!.diffuseTexture.name;
        assert.match(textureName, /^textures\/[0-9a-f]{8}-diffuse_image\.jpg$/);
        assert.equal(
            readFileSync(resolve(destination, "..", textureName), "utf8"),
            "texture",
        );
        const cubeName = document.materials[0]!.reflectionTexture.name;
        assert.match(cubeName, /^textures\/[0-9a-f]{8}-cube$/);
        assert.equal(
            readFileSync(resolve(destination, "..", `${cubeName}_px.jpg`), "utf8"),
            "_px",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
