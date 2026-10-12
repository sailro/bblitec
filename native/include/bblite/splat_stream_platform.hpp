#pragma once

// The web platform the pinned splat-stream library calls, as the lowered
// library (src/lowering/splat-stream-records.ts) spells it. Declarations
// only, typed like the web APIs they stand for: the platform build defines
// them over its native services, a test over deterministic fakes. Every
// object is a handle shared by identity, as the JavaScript object is.

#include <memory>
#include <string>

namespace bbl::splat_stream_platform {

// ── URL (WHATWG) ───────────────────────────────────────────────────────

struct UrlState;
using Url = std::shared_ptr<UrlState>;

/** `new URL(input)`; a TypeError (`bbl::js::NamedError`) when it does not parse. */
[[nodiscard]] Url url_parse(const std::string& input);
/** `new URL(input, base)`: `input` resolved against `base`. */
[[nodiscard]] Url url_parse(const std::string& input, const std::string& base);
/** `url.href`: the serialized URL. */
[[nodiscard]] std::string url_href(const Url& url);
/** `url.protocol`: the scheme with its colon (`"https:"`). */
[[nodiscard]] std::string url_protocol(const Url& url);
/** `url.pathname`: the percent-encoded path. */
[[nodiscard]] std::string url_pathname(const Url& url);
/** `url.pathname = value`: the path replaced, as the setter parses it. */
void url_set_pathname(const Url& url, const std::string& pathname);

// ── AbortSignal ────────────────────────────────────────────────────────

struct AbortSignalState;
using AbortSignal = std::shared_ptr<AbortSignalState>;

} // namespace bbl::splat_stream_platform
