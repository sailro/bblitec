#pragma once

#include <string_view>

namespace bbl::pal {

// Browser defaults stay below author rules for both constructed elements and
// unbound innerHTML descendants. Keep one sheet for the PAL and layout fixtures.
inline constexpr std::string_view ui_user_agent_css =
    "div,canvas{display:block;}\n"
    "h1{display:block;font-size:2em;font-weight:bold;margin:0.67em 0;}\n"
    "h2{display:block;font-size:1.5em;font-weight:bold;margin:0.83em 0;}\n"
    "a[href]{color:#0000ee;text-decoration:underline;cursor:pointer;}\n"
    // Chromium's form-control font (docs/ui.md): the generic sans face two
    // points under the 16px default. The line height is that face's normal
    // ratio (Arial, 2355/2048); left unset it would inherit the document
    // root's 1.32, which is the system face's.
    "button{display:inline-block;box-sizing:border-box;"
    "font-family:sans-serif;font-size:13.333333px;font-weight:normal;"
    "font-style:normal;line-height:1.1499;"
    "text-align:center;tab-index:auto;}\n"
    // Press/release must resolve to the button, not separate label/icon nodes.
    "button *{focus:none;}\n"
    "input[type=range]{display:inline-block;box-sizing:content-box;width:129px;height:16px;margin:2px;padding:0;"
    "border-width:0;tab-index:auto;pointer-events:auto;}\n"
    "input[type=range] slidertrack{height:6px;margin:5px 0;background-color:#efefef;border-width:0;border-radius:3px;}\n"
    "input[type=range] sliderbar{width:16px;height:16px;background-color:#0075ff;border-radius:8px;}\n"
    "input[type=range] sliderprogress{height:6px;background-color:#0075ff;border-radius:3px;}\n"
    "input[type=range] sliderarrowdec,input[type=range] sliderarrowinc{width:0;height:0;}\n"
    // RmlUi creates unstyled scrollbar elements on overflow. In particular,
    // an auto-width vertical scrollbar consumes the entire containing block.
    // Give both axes density-independent geometry and a visible drag handle.
    // Built-in scroll controls need input even though the overlay document
    // passes through pointer events by default, just like reached buttons.
    "scrollbarvertical{width:16dp;pointer-events:auto;}\n"
    "scrollbarhorizontal{height:16dp;pointer-events:auto;}\n"
    "scrollbarvertical,scrollbarhorizontal,scrollbarcorner{background-color:#80808030;}\n"
    "scrollbarvertical slidertrack{width:16dp;}\n"
    "scrollbarhorizontal slidertrack{height:16dp;}\n"
    "scrollbarvertical sliderbar{width:10dp;min-height:24dp;margin:0 3dp;}\n"
    "scrollbarhorizontal sliderbar{height:10dp;min-width:24dp;margin:3dp 0;}\n"
    "scrollbarvertical sliderbar,scrollbarhorizontal sliderbar{background-color:#909090c0;border-radius:5dp;}\n"
    "scrollbarvertical sliderbar:hover,scrollbarhorizontal sliderbar:hover{background-color:#a0a0a0;}\n"
    "scrollbarvertical sliderbar:active,scrollbarhorizontal sliderbar:active{background-color:#b0b0b0;}\n"
    "scrollbarvertical sliderarrowdec,scrollbarvertical sliderarrowinc,"
    "scrollbarhorizontal sliderarrowdec,scrollbarhorizontal sliderarrowinc{width:0;height:0;}\n";

} // namespace bbl::pal
