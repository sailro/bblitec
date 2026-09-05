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
    "button{display:inline-block;box-sizing:border-box;"
    "text-align:center;tab-index:auto;}\n"
    // Press/release must resolve to the button, not separate label/icon nodes.
    "button *{focus:none;}\n";

} // namespace bbl::pal
