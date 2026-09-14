import test from "node:test";
import {runRmlUiFixture} from "./native-fixture.js";

test("innerHTML and retained styles share CSS pixel scaling at every density", t => runRmlUiFixture(t, "ui-markup-density"));
