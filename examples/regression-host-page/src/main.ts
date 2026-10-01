// An engine-less Canvas2D program hosted by ../page.html: it finds the page's
// markup, draws on the page's canvas every animation frame and drives the
// page's controls. The square advances per frame; once it has rested at its
// stop for a few frames, the canvas reports ready.

const canvas = document.querySelector<HTMLCanvasElement>("#renderCanvas");
if (!canvas) throw new Error("the page's canvas is missing");
const context = canvas.getContext("2d");
const status = document.getElementById("status");
const presets = [...document.querySelectorAll<HTMLButtonElement>("[data-preset]")];

const stop = 200;
let paused = false;
let speed = 4;
let offset = 0;
let rested = 0;

function setStatus(): void {
    if (status) {
        status.textContent = `${paused ? "paused" : "running"} at ${speed} px/frame`;
    }
}

function draw(target: CanvasRenderingContext2D): void {
    target.fillStyle = "#14170f";
    target.fillRect(0, 0, target.canvas.width, target.canvas.height);
    target.fillStyle = "#d7a960";
    target.fillRect(20 + offset, 50, 20, 20);
    target.strokeStyle = "#f2ead4";
    target.lineWidth = 2;
    target.strokeRect(16 + offset, 46, 28, 28);
}

function frame(): void {
    if (!paused) offset = Math.min(stop, offset + speed);
    if (context) draw(context);
    if (offset === stop && ++rested === 5) canvas!.dataset.ready = "true";
    requestAnimationFrame(frame);
}

document.getElementById("pause")?.addEventListener("click", () => {
    paused = !paused;
    setStatus();
});
for (const button of presets) {
    button.addEventListener("click", () => {
        speed = button.dataset.preset === "fast" ? 16 : 4;
        for (const other of presets)
            other.setAttribute("aria-pressed", String(other === button));
        setStatus();
    });
}

setStatus();
requestAnimationFrame(frame);
