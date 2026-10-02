const panel = document.createElement("div");
panel.style.cssText = "position:fixed;inset:0;background:#202830;color:#e09840";
document.body.append(panel);

function element(tag: string): SVGElement {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function icon(left: string): SVGElement {
    const svg = element("svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.style.cssText = `position:absolute;left:${left};top:80px;width:144px;height:144px`;
    panel.append(svg);
    return svg;
}

const first = icon("80px");
const circle = element("circle");
circle.setAttribute("cx", "12");
circle.setAttribute("cy", "12");
circle.setAttribute("r", "6");
circle.setAttribute("fill", "none");
circle.setAttribute("stroke", "currentColor");
circle.setAttribute("stroke-width", "2");
const dot = element("circle");
dot.setAttribute("cx", "12");
dot.setAttribute("cy", "12");
dot.setAttribute("r", "3");
dot.setAttribute("fill", "currentColor");
first.append(circle, dot);
first.addEventListener("click", () => {
    first.style.color = "#f08868";
    circle.setAttribute("r", "6");
});

const second = icon("280px");
const rectangle = element("rect");
rectangle.setAttribute("x", "4");
rectangle.setAttribute("y", "4");
rectangle.setAttribute("width", "16");
rectangle.setAttribute("height", "16");
rectangle.setAttribute("rx", "3");
rectangle.setAttribute("fill", "#60c0a0");
second.append(rectangle);

const third = icon("480px");
const triangle = element("path");
triangle.setAttribute("d", "M5 3 L21 12 L5 21 Z");
triangle.setAttribute("fill", "currentColor");
third.append(triangle);

requestAnimationFrame(() => {
    panel.style.color = "#80b8f0";
    circle.setAttribute("r", "9");
    third.replaceChildren(dot, triangle);
    dot.setAttribute("cx", "5");
    dot.setAttribute("r", "2");
});
