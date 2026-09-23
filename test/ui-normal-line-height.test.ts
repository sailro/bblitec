import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("normal line height follows each font and retains authored inheritance", (t) => {
    runRmlUiFixture(t, "ui-normal-line-height");
});
