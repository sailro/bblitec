import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("retained RmlUi creation and updates decode markup entities and preserve literal text", t => {
    runRmlUiFixture(t, "ui-markup-runtime");
});
