#pragma once

#include <string_view>

namespace bbl::pal {

// Browser defaults stay below author rules for both constructed elements and
// unbound innerHTML descendants. Keep one sheet for the PAL and layout fixtures.
// Control colors are Chromium 152's light palette; each :bbl-dark-scheme
// (color-scheme: dark) variant follows its light rule at the same specificity.
inline constexpr std::string_view ui_user_agent_css =
    "div,canvas{display:block;}\n"
    "details,summary{display:block;}\n"
    "summary{tab-index:auto;pointer-events:auto;cursor:pointer;}\n"
    // Chromium's inside disclosure marker: a 0.66em symbol and 0.4em before the text.
    "details > summary:first-of-type{padding-left:1.06em;decorator:bbl-native-control-mark();}\n"
    "summary *{focus:none;}\n"
    "details:not([open]) > :not(summary){display:none;}\n"
    "details:not([open]) > summary:not(:first-of-type){display:none;}\n"
    "ul,ol{display:block;margin:1em 0;padding-left:40px;}\n"
    "li{display:block;}\n"
    "[hidden],script{display:none;}\n"
    // Chromium's sectioning and grouping elements, and its heading levels.
    "address,article,aside,blockquote,figcaption,figure,footer,form,header,hgroup,main,nav,"
    "section{display:block;}\n"
    "h1{display:block;font-size:2em;font-weight:bold;margin:0.67em 0;}\n"
    "h2{display:block;font-size:1.5em;font-weight:bold;margin:0.83em 0;}\n"
    "h3{display:block;font-size:1.17em;font-weight:bold;margin:1em 0;}\n"
    "h4{display:block;font-weight:bold;margin:1.33em 0;}\n"
    "h5{display:block;font-size:0.83em;font-weight:bold;margin:1.67em 0;}\n"
    "h6{display:block;font-size:0.67em;font-weight:bold;margin:2.33em 0;}\n"
    "p{display:block;margin:1em 0;}\n"
    "code,kbd,samp,tt{font-family:monospace;}\n"
    "b,strong{font-weight:bold;}\n"
    // :where keeps the attribute test from outranking an author class.
    "a:where([href]){color:#0000ee;text-decoration:underline;cursor:pointer;}\n"
    "a:where([href]):where(:bbl-dark-scheme){color:#9e9eff;}\n"
    // Chromium's form-control font (docs/ui.md): the generic sans face two
    // points under the 16px default. The line height is that face's normal
    // ratio (Arial, 2355/2048); left unset it would inherit the document
    // root's line-height policy.
    "button{display:inline-block;box-sizing:border-box;"
    "font-family:sans-serif;font-size:13.333333px;font-weight:normal;"
    "font-style:normal;line-height:1.1499;"
    "text-align:center;tab-index:auto;}\n"
    // Press/release must resolve to the button, not separate label/icon nodes.
    "button *{focus:none;}\n"
    "input[type=checkbox]{display:inline-block;width:13px;height:13px;margin:3px 3px 3px 4px;"
    "padding:0;border-width:1px;border-color:#767676;border-radius:2px;background-color:#ffffff;"
    "box-sizing:border-box;tab-index:auto;pointer-events:auto;}\n"
    "input[type=checkbox]:where(:bbl-dark-scheme){border-color:#858585;background-color:#3b3b3b;}\n"
    "input[type=checkbox]:checked{background-color:#0075ff;border-color:#0075ff;"
    "decorator:bbl-native-control-mark();}\n"
    "input[type=checkbox]:checked:where(:bbl-dark-scheme){background-color:#99c8ff;"
    "border-color:#99c8ff;}\n"
    "input[type=checkbox]:checked:where(:bbl-accent){background-color:var(--bbl-accent);"
    "border-color:var(--bbl-accent);}\n"
    "input[type=checkbox]:disabled{opacity:0.45;}\n"
    "input[type=color]{display:inline-block;width:50px;height:27px;box-sizing:border-box;"
    "padding:1px 2px;border-width:1px;border-color:#767676;border-radius:2px;background-color:#efefef;"
    "tab-index:auto;pointer-events:auto;cursor:pointer;}\n"
    "input[type=color]:where(:bbl-dark-scheme){border-color:#6b6b6b;background-color:#6b6b6b;}\n"
    "input[type=color]:disabled{opacity:0.45;}\n"
    "select{display:inline-block;box-sizing:border-box;min-width:48px;height:auto;"
    "padding:0;border-width:1px;border-color:#767676;border-radius:2px;"
    "background-color:#ffffff;color:#000000;font-family:sans-serif;font-size:13.333333px;"
    "font-weight:normal;font-style:normal;line-height:1.1499;"
    "tab-index:auto;pointer-events:auto;nav-up:none;nav-down:none;}\n"
    "select:where(:bbl-dark-scheme){border-color:#858585;background-color:#3b3b3b;"
    "color:#ffffff;}\n"
    "select selectvalue{display:block;overflow:hidden;white-space:nowrap;focus:none;}\n"
    "select selectarrow{width:20px;height:20px;background-color:transparent;focus:none;"
    "decorator:bbl-native-select-arrow();}\n"
    "select selectbox{display:block;background-color:#ffffff;color:#000000;"
    "border-width:1px;border-color:#767676;max-height:240px;pointer-events:auto;}\n"
    "select option{display:block;padding:2px 4px;pointer-events:auto;}\n"
    "select option:hover,select option:checked{background-color:#0075ff;color:#ffffff;}\n"
    // Chromium's open menu is a separate widget; it takes the closed control's palette.
    "select:where(:bbl-dark-scheme) selectbox{background-color:#3b3b3b;color:#ffffff;"
    "border-color:#858585;}\n"
    "select:where(:bbl-dark-scheme) option:hover,select:where(:bbl-dark-scheme) option:checked"
    "{background-color:#99c8ff;color:#3b3b3b;}\n"
    "input[type=range]{display:inline-block;box-sizing:content-box;width:auto;height:auto;margin:2px;padding:0;"
    "border-width:0;tab-index:auto;pointer-events:auto;}\n"
    "input[type=range]{decorator:bbl-native-range();}\n"
    ":where(input[type=range]) > :where(slidertrack){height:auto;margin:0;background-color:transparent;border-width:0;}\n"
    ":where(input[type=range]) > :where(sliderbar){width:16px;height:16px;background-color:transparent;}\n"
    "input[type=range] sliderprogress{height:6px;background-color:transparent;}\n"
    "input[type=range] sliderarrowdec,input[type=range] sliderarrowinc{width:0;height:0;}\n"
    // RmlUi creates unstyled scrollbar elements on overflow. In particular,
    // an auto-width vertical scrollbar consumes the entire containing block.
    // Give both axes density-independent geometry and a visible drag handle.
    // Built-in scroll controls need input even though the overlay document
    // passes through pointer events by default, just like reached buttons.
    "scrollbarvertical{width:15dp;pointer-events:auto;}\n"
    "scrollbarhorizontal{height:15dp;pointer-events:auto;}\n"
    "scrollbarvertical,scrollbarhorizontal,scrollbarcorner{background-color:#fcfcfc;}\n"
    "scrollbarvertical slidertrack{width:15dp;}\n"
    "scrollbarhorizontal slidertrack{height:15dp;}\n"
    "scrollbarvertical sliderbar{width:9dp;min-height:24dp;margin:0 3dp;}\n"
    "scrollbarhorizontal sliderbar{height:9dp;min-width:24dp;margin:3dp 0;}\n"
    "scrollbarvertical sliderbar,scrollbarhorizontal sliderbar{background-color:#8b8b8b;border-radius:5dp;}\n"
    "scrollbarvertical sliderbar:hover,scrollbarhorizontal sliderbar:hover{background-color:#636363;}\n"
    "scrollbarvertical sliderbar:active,scrollbarhorizontal sliderbar:active{background-color:#636363;}\n"
    "scrollbarvertical sliderarrowdec,scrollbarvertical sliderarrowinc,"
    "scrollbarhorizontal sliderarrowdec,scrollbarhorizontal sliderarrowinc{width:15dp;height:15dp;"
    "color:#8b8b8b;decorator:bbl-native-scroll-arrow();}\n"
    ":where(:bbl-dark-scheme) > scrollbarvertical,:where(:bbl-dark-scheme) > scrollbarhorizontal,"
    ":where(:bbl-dark-scheme) > scrollbarcorner{background-color:#2c2c2c;}\n"
    ":where(:bbl-dark-scheme) > scrollbarvertical sliderbar,"
    ":where(:bbl-dark-scheme) > scrollbarhorizontal sliderbar{background-color:#9f9f9f;}\n"
    ":where(:bbl-dark-scheme) > scrollbarvertical sliderbar:hover,"
    ":where(:bbl-dark-scheme) > scrollbarhorizontal sliderbar:hover,"
    ":where(:bbl-dark-scheme) > scrollbarvertical sliderbar:active,"
    ":where(:bbl-dark-scheme) > scrollbarhorizontal sliderbar:active{background-color:#d1d1d1;}\n"
    ":where(:bbl-dark-scheme) > scrollbarvertical sliderarrowdec,"
    ":where(:bbl-dark-scheme) > scrollbarvertical sliderarrowinc,"
    ":where(:bbl-dark-scheme) > scrollbarhorizontal sliderarrowdec,"
    ":where(:bbl-dark-scheme) > scrollbarhorizontal sliderarrowinc{color:#9f9f9f;}\n"
    ":bbl-thin-scrollbar > scrollbarvertical{width:8dp;}\n"
    ":bbl-thin-scrollbar > scrollbarhorizontal{height:8dp;}\n"
    ":bbl-thin-scrollbar > scrollbarvertical slidertrack{width:8dp;}\n"
    ":bbl-thin-scrollbar > scrollbarhorizontal slidertrack{height:8dp;}\n"
    ":bbl-thin-scrollbar > scrollbarvertical sliderbar{width:4dp;margin:0 2dp;}\n"
    ":bbl-thin-scrollbar > scrollbarhorizontal sliderbar{height:4dp;margin:2dp 0;}\n"
    ":bbl-thin-scrollbar > scrollbarvertical sliderarrowdec,:bbl-thin-scrollbar > scrollbarvertical sliderarrowinc,"
    ":bbl-thin-scrollbar > scrollbarhorizontal sliderarrowdec,:bbl-thin-scrollbar > scrollbarhorizontal sliderarrowinc{width:0;height:0;}\n"
    ":bbl-hidden-scrollbar > scrollbarvertical{width:0;opacity:0;pointer-events:none;}\n"
    ":bbl-hidden-scrollbar > scrollbarhorizontal{height:0;opacity:0;pointer-events:none;}\n"
    ":bbl-hidden-scrollbar > scrollbarvertical slidertrack,:bbl-hidden-scrollbar > scrollbarvertical sliderbar{width:0;margin:0;}\n"
    ":bbl-hidden-scrollbar > scrollbarhorizontal slidertrack,:bbl-hidden-scrollbar > scrollbarhorizontal sliderbar{height:0;margin:0;}\n"
    ":bbl-colored-scrollbar > scrollbarvertical,:bbl-colored-scrollbar > scrollbarhorizontal,"
    ":bbl-colored-scrollbar > scrollbarcorner{background-color:var(--bbl-scrollbar-track);}\n"
    ":bbl-colored-scrollbar > scrollbarvertical sliderbar,:bbl-colored-scrollbar > scrollbarhorizontal sliderbar"
    "{background-color:var(--bbl-scrollbar-thumb);}\n";

} // namespace bbl::pal
