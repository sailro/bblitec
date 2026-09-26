import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("native image inheritance, scale composition and zero clipping preserve authored state", (t) => {
    runRmlUiFixture(t, "ui-image-background", {imageDecoder: true});
});
