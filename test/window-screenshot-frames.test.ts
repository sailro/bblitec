import test from "node:test";
import { join, resolve } from "node:path";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("window screenshot checkpoints validate, capture fresh files and preserve final stop behavior", (t) => {
    const output = resolve("artifacts/window-screenshot-frames");
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-screenshot-frames", {
        includeDirectories: [join(output, "upstream/include")],
    });
});
