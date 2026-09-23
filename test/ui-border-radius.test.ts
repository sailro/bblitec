import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("percentage border radii retain circular and elliptical geometry through layout changes", (t) => {
    runRmlUiFixture(t, "ui-border-radius");
});
