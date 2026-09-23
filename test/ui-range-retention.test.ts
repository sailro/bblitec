import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("range decorator reloads retain textures and release overlapping handles safely", (t) => {
    runRmlUiFixture(t, "ui-range-retention");
});
