import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("select auto sizing, arrow alignment and pointer selection retain their controls", (t) => {
    runRmlUiFixture(t, "ui-select-layout");
});
