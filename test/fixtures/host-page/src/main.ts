// An engine-less Canvas2D program hosted by ../page.html: it finds the page's
// markup, draws on the page's canvas every animation frame and drives the
// page's controls.

const canvas = document.querySelector<HTMLCanvasElement>("#view");
if (!canvas) throw new Error("the page's canvas is missing");
const context = canvas.getContext("2d");
const status = document.getElementById("status");
const presets = [...document.querySelectorAll<HTMLButtonElement>("[data-preset]")];

let paused = false;
let speed = 40;
let offset = 0;
let last = 0;

function setStatus(): void {
    if (status) {
        status.textContent = `${paused ? "paused" : "running"} at ${speed} px/s`;
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

function frame(now: number): void {
    const delta = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) offset = (offset + delta * speed) % 260;
    if (context) draw(context);
    requestAnimationFrame(frame);
}

document.getElementById("pause")?.addEventListener("click", () => {
    paused = !paused;
    setStatus();
});
for (const button of presets) {
    button.addEventListener("click", () => {
        speed = button.dataset.preset === "fast" ? 160 : 40;
        for (const other of presets)
            other.setAttribute("aria-pressed", String(other === button));
        setStatus();
    });
}

setStatus();
requestAnimationFrame(frame);
