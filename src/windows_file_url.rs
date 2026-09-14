//! Windows `file:` URL rules (issue #744): a UNC path round trips through the
//! URL authority — `\\server\share\a.ts` <-> `file://server/share/a.ts` —
//! while a drive-letter path keeps the `file:///C:/…` form. Compiled into
//! test builds on every platform so the matrix below runs wherever `cargo
//! test` does; production builds on other platforms exclude it entirely.

use std::borrow::Cow;
use std::path::PathBuf;

use super::hex_digit;

/// Percent-decode one URL component, validating the decoded bytes as UTF-8.
/// Two vectorised passes carry this function, and the byte loop only ever
/// runs over the escaped tail: `memchr` finds the first escape, and
/// `simdutf8` validates the decoded buffer.
fn percent_decode(input: &str) -> Option<Cow<'_, str>> {
    let bytes = input.as_bytes();
    let Some(mut index) = memchr::memchr(b'%', bytes) else {
        return Some(Cow::Borrowed(input));
    };

    let mut decoded = Vec::with_capacity(bytes.len());
    decoded.extend_from_slice(&bytes[..index]);
    while index < bytes.len() {
        // A `%` that is not followed by two hex digits is not an escape. Node
        // will not produce one, but a hand-written URL can, and copying it
        // through verbatim beats refusing the whole path.
        if bytes[index] == b'%'
            && let Some(byte) = bytes
                .get(index + 1)
                .zip(bytes.get(index + 2))
                .and_then(|(high, low)| Some(hex_digit(*high)? << 4 | hex_digit(*low)?))
        {
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    let text = simdutf8::basic::from_utf8(&decoded).ok()?;
    Some(Cow::Owned(text.to_owned()))
}

/// Convert a `file://` URL into a filesystem path: `file:///C:/…` keeps
/// the drive form, and `file://server/share/…` maps its authority back to
/// a leading `\\server\…`, the same reading `fileURLToPath` gives it.
/// Returns `None` for non-`file:` URLs and escapes that do not decode to
/// valid UTF-8.
pub(super) fn url_to_path(url: &str) -> Option<PathBuf> {
    // Schemes are case-insensitive — `FILE://…` is a file URL like any
    // other — and the URL parser removes every ASCII tab or newline before
    // parsing, so `fi\tle://…` is one too.
    let cleaned;
    let url = if url.contains(['\t', '\n', '\r']) {
        cleaned = url.replace(['\t', '\n', '\r'], "");
        &cleaned
    } else {
        url
    };
    if !url.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file://")) {
        return None;
    }
    let rest = &url[7..];
    if rest.is_empty() {
        return None;
    }
    // The query and fragment are not part of the filesystem path — Node
    // validates and decodes the pathname only — so split them off before the
    // separator checks; `create_resolve` re-attaches them for module identity.
    let (rest, _suffix) = match rest.find(['?', '#']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    // The URL parser folds a drive-letter authority back into the path:
    // `file://C:/app.ts` is `file:///C:/app.ts`, and the `c|` spelling
    // normalizes to `c:` before `fileURLToPath` runs.
    let bytes = rest.as_bytes();
    if bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && matches!(bytes[1], b':' | b'|')
        && (bytes.len() == 2 || bytes[2] == b'/' || bytes[2] == b'\\')
    {
        let mut path = String::with_capacity(rest.len());
        path.push(bytes[0] as char);
        path.push(':');
        path.push_str(&rest[2..]);
        return decode_path(&path);
    }
    // Drive form: `file:///C:/a/b` — the slash after the scheme anchors
    // the drive letter, and stripping it leaves `C:/a/b` where it belongs.
    if let Some(path) = rest.strip_prefix('/') {
        return decode_path(path);
    }
    // UNC form: `file://server/share/a`. The URL parser treats `\` as `/`
    // in special schemes, so an absolute specifier may arrive with either
    // separator and the authority ends at the first of either.
    let (host, path) = match rest.find(['/', '\\']) {
        Some(index) => (&rest[..index], &rest[index + 1..]),
        None => (rest, ""),
    };
    // The URL parser rejects an authority whose escapes decode to forbidden
    // host code points (`file://server%5Cother/…` is ERR_INVALID_URL), and
    // decodes the rest through IDNA to-ASCII before `fileURLToPath` maps it
    // back — so an allowed escape such as `%C3%BD` still reaches us as the
    // Unicode name the punycode authority denotes.
    if has_forbidden_host_escape(host) || has_forbidden_host_char(host, true) {
        return None;
    }
    let host = percent_decode(host)?;
    // UTS #46 host canonicalization comes first, matching the parser's
    // order — `１２７.１` maps to `127.1` and is then recognized as IPv4.
    let host = canonicalize_host(&host)?;
    // The forbidden-character check also runs on the mapped authority: a
    // fullwidth `％` maps to `%`, which the URL parser then rejects. Mapped
    // hosts hold no escapes, so the `%` exemption does not apply.
    if has_forbidden_host_char(&host, false) {
        return None;
    }
    let mut host: Cow<'_, str> = match parse_ipv4_authority(&host) {
        Ipv4Authority::Address(address) => Cow::Owned(address.to_string()),
        Ipv4Authority::Invalid => return None,
        Ipv4Authority::NotIpv4 => Cow::Owned(host),
    };
    // WHATWG canonicalizes IPv6 authorities: `[0:0:0:0:0:0:0:1]` is `[::1]`.
    if host.len() > 2 && host.starts_with('[') && host.ends_with(']') {
        let (address, zone) = match host[1..host.len() - 1].split_once('%') {
            Some((address, zone)) => (address, Some(zone)),
            None => (&host[1..host.len() - 1], None),
        };
        if let Ok(parsed) = address.parse::<std::net::Ipv6Addr>() {
            host = Cow::Owned(match zone {
                Some(zone) => format!("[{}%{}]", serialize_ipv6(&parsed), zone),
                None => format!("[{}]", serialize_ipv6(&parsed)),
            });
        }
    }
    if host.eq_ignore_ascii_case("localhost") {
        // `file://localhost/…` is the local drive form: `fileURLToPath`
        // requires an absolute drive path (`file://localhost/share/…` is
        // rejected). A raw `c|` spelling folds to `c:` at parse time, but
        // an encoded `%7C` decodes too late — `file://localhost/c%7C/…`
        // is rejected — so the drive check after decoding accepts only
        // `:`; a percent-encoded drive letter (`%43%3A`) decodes fine.
        let mut raw = path;
        let normalized;
        let raw_bytes = raw.as_bytes();
        if raw_bytes.len() >= 2
            && raw_bytes[0].is_ascii_alphabetic()
            && raw_bytes[1] == b'|'
            && (raw_bytes.len() == 2 || raw_bytes[2] == b'/' || raw_bytes[2] == b'\\')
        {
            normalized = format!("{}:{}", raw_bytes[0] as char, &raw[2..]);
            raw = &normalized;
        }
        let decoded = decode_path_string(raw)?;
        let bytes = decoded.as_bytes();
        if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
            return None;
        }
        let mut drive = String::with_capacity(decoded.len());
        drive.push(bytes[0] as char);
        drive.push(':');
        drive.push_str(&decoded[2..]);
        return Some(PathBuf::from(drive));
    }
    let path = decode_path_string(path)?;
    let mut unc = String::with_capacity(host.len() + path.len() + 3);
    unc.push_str("\\\\");
    unc.push_str(&host);
    unc.push('\\');
    unc.push_str(&path.replace('/', "\\"));
    Some(PathBuf::from(unc))
}

/// The `pathToFileURL` mapping: a `\\` or `//` prefix makes the first
/// component the UNC authority — percent-encoded — and everything else
/// keeps the `file:///<drive>:/…` form.
pub(super) fn path_to_url(path: &str) -> String {
    // Canonicalized paths carry the extended-length prefix (`\\?\`), which
    // the `pathToFileURL` mapping ignores.
    if let Some(stripped) = path.strip_prefix("\\\\?\\UNC\\") {
        return unc_path_to_url(stripped);
    }
    let path = path.strip_prefix("\\\\?\\").unwrap_or(path);
    if let Some(stripped) = path.strip_prefix("\\\\").or_else(|| path.strip_prefix("//")) {
        return unc_path_to_url(stripped);
    }
    format!("file:///{path}").replace('\\', "/")
}

fn unc_path_to_url(stripped: &str) -> String {
    let (host, rest) = match stripped.find(['\\', '/']) {
        Some(index) => (&stripped[..index], &stripped[index + 1..]),
        None => (stripped, ""),
    };
    // The path is encoded the way the `file:` URL path setter encodes
    // it: `/` separators stay, everything outside the unreserved set
    // becomes `%XX`. Over-encoding is safe — a URL parser decodes
    // `%XX` back to the same file — while under-encoding is not: a
    // literal `%` would be read as an escape and a `#` as a fragment.
    let rest = rest.replace('\\', "/");
    let rest = encode_path(&rest);
    format!("file://{}/{rest}", encode_host(host))
}

enum Ipv4Authority {
    /// The authority is not IPv4; host handling continues normally.
    NotIpv4,
    /// The canonical dotted-quad the authority denotes.
    Address(std::net::Ipv4Addr),
    /// Ends in a number but is not a valid IPv4 address (`ERR_INVALID_URL`).
    Invalid,
}

/// WHATWG IPv4 parsing for special-scheme authorities: when the last label
/// is syntactically a number, the whole authority must parse as IPv4 —
/// decimal, `0x` hex, and leading-zero octal parts, with the last part
/// filling the remaining bytes (`127.1` is `127.0.0.1`) — or the URL is
/// invalid. A single trailing dot is dropped for classification: FQDNs
/// keep it (`server.example.`), numeric hosts canonicalize without it
/// (`127.1.` is `127.0.0.1`), and a double dot is an ordinary hostname.
fn parse_ipv4_authority(host: &str) -> Ipv4Authority {
    let candidate = host.strip_suffix('.').unwrap_or(host);
    let Some(last) = candidate.rsplit('.').next() else {
        return Ipv4Authority::NotIpv4;
    };
    if !ends_in_number(last) {
        return Ipv4Authority::NotIpv4;
    }
    let parts: Vec<&str> = candidate.split('.').collect();
    if parts.len() > 4 || parts.iter().any(|part| part.is_empty()) {
        return Ipv4Authority::Invalid;
    }
    let mut numbers = [0u64; 4];
    for (index, part) in parts.iter().enumerate() {
        let Some(value) = ipv4_number(part) else {
            return Ipv4Authority::Invalid;
        };
        let max =
            if index == parts.len() - 1 { 1u64 << (8 * (5 - parts.len()) as u32) } else { 256 };
        if value >= max {
            return Ipv4Authority::Invalid;
        }
        numbers[index] = value;
    }
    let last_value = numbers[parts.len() - 1];
    let mut octets = [0u8; 4];
    for (index, number) in numbers.iter().enumerate().take(parts.len() - 1) {
        octets[index] = *number as u8;
    }
    let remaining = 4 - (parts.len() - 1);
    for index in 0..remaining {
        octets[4 - remaining + index] = (last_value >> (8 * (remaining - 1 - index))) as u8;
    }
    Ipv4Authority::Address(std::net::Ipv4Addr::from(octets))
}

/// WHATWG IPv6 serializer: eight lowercase hex groups with the longest zero
/// run compressed (first on ties, only when at least two groups). Unlike
/// `Ipv6Addr`'s display, IPv4-mapped addresses serialize as plain groups —
/// `[::ffff:c0a8:1]`, not `[::ffff:192.168.0.1]`.
fn serialize_ipv6(address: &std::net::Ipv6Addr) -> String {
    let segments = address.segments();
    let mut best_start = 8;
    let mut best_len = 0;
    let mut index = 0;
    while index < 8 {
        if segments[index] != 0 {
            index += 1;
            continue;
        }
        let start = index;
        while index < 8 && segments[index] == 0 {
            index += 1;
        }
        if index - start > best_len {
            best_start = start;
            best_len = index - start;
        }
    }
    if best_len < 2 {
        best_start = 8;
    }
    let mut out = String::new();
    let mut index = 0;
    while index < 8 {
        if index == best_start {
            out.push_str("::");
            index += best_len;
            continue;
        }
        if !out.is_empty() && !out.ends_with(':') {
            out.push(':');
        }
        out.push_str(&format!("{:x}", segments[index]));
        index += 1;
    }
    if out.is_empty() {
        out.push_str("::");
    }
    out
}

/// WHATWG ends-in-a-number: the label is non-empty and all ASCII digits,
/// or a `0x` prefix followed by hex digits (a bare `0x` counts).
fn ends_in_number(label: &str) -> bool {
    let bytes = label.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    if bytes.iter().all(|byte| byte.is_ascii_digit()) {
        return true;
    }
    bytes.len() >= 2
        && bytes[0] == b'0'
        && (bytes[1] | 0x20) == b'x'
        && bytes[2..].iter().all(|byte| byte.is_ascii_hexdigit())
}

/// WHATWG IPv4 number parser: `0x` hex, leading-zero octal, decimal; a
/// bare prefix (`0x`, `00`) is numeric zero, as the parser defines.
fn ipv4_number(part: &str) -> Option<u64> {
    let bytes = part.as_bytes();
    let (radix, digits) = if bytes.len() >= 2 && bytes[0] == b'0' && (bytes[1] | 0x20) == b'x' {
        (16, &part[2..])
    } else if bytes.len() > 1 && bytes[0] == b'0' {
        (8, &part[1..])
    } else {
        (10, part)
    };
    if digits.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(digits, radix).ok()
}

/// Percent-encode a UNC server name for the URL authority: every byte
/// outside the unreserved ASCII set becomes `%XX` with uppercase hex,
/// matching what `pathToFileURL` writes for a host such as `my server`.
fn encode_host(host: &str) -> Cow<'_, str> {
    // Bracketed IPv6 literals keep their authority syntax — percent-encoding
    // the brackets produces a URL Node rejects (ERR_INVALID_URL) — and are
    // canonicalized the way the URL parser canonicalizes them.
    if host.len() > 2 && host.starts_with('[') && host.ends_with(']') {
        if let Ok(parsed) = host[1..host.len() - 1].parse::<std::net::Ipv6Addr>() {
            return Cow::Owned(format!("[{}]", serialize_ipv6(&parsed)));
        }
        return Cow::Borrowed(host);
    }
    percent_encode(host, &[])
}

/// UTS #46 host canonicalization for a UNC authority, applied the way the
/// URL parser applies `to-ascii` at parse time and `fileURLToPath` maps the
/// name back: fullwidth and compatibility characters fold to their ASCII
/// forms and valid `xn--` labels decode to Unicode. Lenient behavior is
/// per-label, the way Node behaves: undecodable `xn--` labels keep their
/// literal spelling, while labels that fail for any other reason (disallowed
/// characters like a zero-width joiner) or map to nothing (a lone soft
/// hyphen) reject the host.
fn canonicalize_host(host: &str) -> Option<String> {
    let mut out = String::with_capacity(host.len());
    for (index, label) in host.split('.').enumerate() {
        if index > 0 {
            out.push('.');
        }
        if label.is_empty() {
            // Empty labels (a trailing dot) are kept as-is.
            continue;
        }
        match idna::domain_to_ascii(label) {
            Ok(ascii) if !ascii.is_empty() => out.push_str(&idna::domain_to_unicode(&ascii).0),
            Ok(_) => return None,
            Err(_) if is_ace_label(label) => out.push_str(label),
            Err(_) => return None,
        }
    }
    Some(out)
}

/// True when a label carries the `xn--` A-label prefix.
fn is_ace_label(label: &str) -> bool {
    label.len() >= 4 && label.as_bytes()[..4].eq_ignore_ascii_case(b"xn--")
}

/// WHATWG URL path normalization, applied to the percent-encoded path: a
/// dot segment (`.`, `..`, and their `%2e` spellings — `%2E`/`%2e` count
/// as a dot) vanishes or pops the previous segment, never crossing a drive
/// prefix (`C:/../x` stays `C:/x`) or the share root, and a trailing dot
/// segment leaves a trailing slash. `%2E` inside a longer segment stays a
/// filename character, exactly as the URL parser treats it.
fn normalize_dot_segments(path: &str) -> Cow<'_, str> {
    // A leading pipe-form drive segment needs folding even when no dot
    // segment is present; a pipe anywhere else stays literal.
    let mut first = true;
    let needs_work = path.split('/').any(|segment| {
        let pipe_drive = first
            && segment.len() == 2
            && is_drive_prefix(segment)
            && segment.as_bytes()[1] == b'|';
        first = false;
        dot_segment_kind(segment) != 0 || pipe_drive
    });
    if !needs_work {
        return Cow::Borrowed(path);
    }
    let trailing_slash =
        path.rsplit('/').next().is_some_and(|segment| dot_segment_kind(segment) != 0);
    let mut out: Vec<Cow<'_, str>> = Vec::new();
    for segment in path.split('/') {
        match dot_segment_kind(segment) {
            1 => {}
            2 => {
                if out.len() > 1 || out.first().is_some_and(|first| !is_drive_prefix(first)) {
                    out.pop();
                }
            }
            _ => {
                // A kept leading drive segment normalizes its pipe spelling,
                // like the URL parser does; later segments keep theirs.
                let bytes = segment.as_bytes();
                if out.is_empty()
                    && bytes.len() == 2
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b'|'
                {
                    out.push(Cow::Owned(format!("{}:", bytes[0] as char)));
                } else {
                    out.push(Cow::Borrowed(segment));
                }
            }
        }
    }
    let mut normalized = out.join("/");
    if trailing_slash {
        normalized.push('/');
    }
    Cow::Owned(normalized)
}

/// 1 for a single-dot segment (`.` or `%2e`), 2 for a double-dot segment
/// (`..`, `.%2e`, `%2e.`, `%2e%2e`, any hex case), 0 otherwise.
fn dot_segment_kind(segment: &str) -> u8 {
    let bytes = segment.as_bytes();
    let mut dots = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'.' {
            dots += 1;
            index += 1;
        } else if bytes.len() - index >= 3
            && bytes[index] == b'%'
            && bytes[index + 1] == b'2'
            && (bytes[index + 2] | 0x20) == b'e'
        {
            dots += 1;
            index += 3;
        } else {
            return 0;
        }
        if dots > 2 {
            return 0;
        }
    }
    dots
}

fn is_drive_prefix(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && matches!(bytes[1], b':' | b'|')
}

/// Percent-decode a URL path, refusing the escapes `fileURLToPath`
/// rejects: `%5C`/`%2F` become real separators and would let the URL text
/// denote a file outside the directory its path names, and a malformed
/// escape makes Node's `decodeURIComponent` throw. The query/fragment are
/// not part of the filesystem path and are dropped, like Node's pathname
/// handling; `create_resolve` re-attaches them for module identity.
fn decode_path(path: &str) -> Option<PathBuf> {
    decode_path_string(path).map(|decoded| PathBuf::from(decoded.into_owned()))
}

/// Percent-decode a URL path, refusing the escapes `fileURLToPath`
/// rejects: `%5C`/`%2F` become real separators and would let the URL text
/// denote a file outside the directory its path names, and a malformed
/// escape makes Node's `decodeURIComponent` throw.
fn decode_path_string(path: &str) -> Option<Cow<'_, str>> {
    // The URL parser treats `\` as `/` throughout a special-scheme URL, so
    // the path portion may arrive with either separator; normalize before
    // the dot-segment pass. `buf` holds any intermediate buffer so the
    // borrowed fast path stays zero-copy.
    let mut buf: Option<String> = None;
    let mut cur: &str = path;

    if cur.contains('\\') {
        buf = Some(cur.replace('\\', "/"));
        cur = buf.as_deref().unwrap_or_default();
    }

    if cur.split('/').any(|segment| {
        dot_segment_kind(segment) != 0
            || (segment.len() == 2 && is_drive_prefix(segment) && segment.as_bytes()[1] == b'|')
    }) {
        let normalized = normalize_dot_segments(cur).into_owned();
        buf = Some(normalized);
        cur = buf.as_deref().unwrap_or_default();
    }

    let bytes = cur.as_bytes();
    let mut search_from = 0;
    while let Some(relative) = bytes[search_from..].iter().position(|&byte| byte == b'%') {
        let index = search_from + relative;
        match hex_byte(bytes, index) {
            Some(0x2f | 0x5c) => return None,
            Some(_) => search_from = index + 3,
            None => return None,
        }
    }
    match percent_decode(cur) {
        // A decoded `?` cannot be handed to the resolver: its `\0` escape
        // exists only for `#`, so it would be parsed as a query and a
        // same-named prefix file could win. `?` is illegal in Windows file
        // names anyway, so the literal name can only fail — Node fails too
        // (ENOENT) — and failing here matches that.
        Some(Cow::Borrowed(_)) => {
            if cur.contains('?') {
                return None;
            }
            Some(match buf {
                Some(buf) => Cow::Owned(buf),
                None => Cow::Borrowed(path),
            })
        }
        Some(Cow::Owned(decoded)) => {
            if decoded.contains('?') {
                return None;
            }
            Some(Cow::Owned(decoded))
        }
        None => None,
    }
}

/// True when an authority escape decodes to a code point the URL parser
/// forbids in a special-scheme host (controls, space, `"` `#` `%` `/` `:`
/// `<` `>` `?` `@` `[` `\` `]` `^` `|` DEL), or a `%` is not a valid escape
/// at all — Node rejects such hosts outright (`ERR_INVALID_URL`).
fn has_forbidden_host_escape(host: &str) -> bool {
    let bytes = host.as_bytes();
    let mut search_from = 0;
    while let Some(relative) = bytes[search_from..].iter().position(|&byte| byte == b'%') {
        let index = search_from + relative;
        match hex_byte(bytes, index) {
            Some(byte) if forbidden_host_byte(byte) => return true,
            Some(_) => search_from = index + 3,
            None => return true,
        }
    }
    false
}

/// True when the authority carries a raw character Node's URL parser
/// forbids in a special-scheme host. Bracketed IPv6 literals (`[::1]`)
/// keep their `:`, which is otherwise forbidden. `escapes_allowed` is
/// false for the UTS #46-mapped authority, where no escapes remain and a
/// literal `%` (mapped from `％`) is forbidden outright.
fn has_forbidden_host_char(host: &str, escapes_allowed: bool) -> bool {
    if host.len() > 2 && host.starts_with('[') && host.ends_with(']') {
        // The bracket exception holds only for genuine IPv6 literals —
        // `file://[foo]/…` is ERR_INVALID_URL in Node, and the fallback
        // below rejects the brackets as forbidden characters.
        let address = host[1..host.len() - 1].split('%').next().unwrap_or_default();
        if address.parse::<std::net::Ipv6Addr>().is_ok() {
            return false;
        }
    }
    // `%` is legal inside a valid escape when escapes are allowed —
    // malformed there, forbidden when it decodes to a `%`.
    host.bytes().any(|byte| !(escapes_allowed && byte == b'%') && forbidden_host_byte(byte))
}

/// Decode one `%XX` escape at `index`; `None` when it is malformed.
fn hex_byte(bytes: &[u8], index: usize) -> Option<u8> {
    if bytes.len() - index < 3 {
        return None;
    }
    Some(super::hex_digit(bytes[index + 1])? * 16 + super::hex_digit(bytes[index + 2])?)
}

fn forbidden_host_byte(byte: u8) -> bool {
    // Matches the characters Node's parser rejects in file authorities
    // (verified empirically): controls, space, `#` `%` `/` `:` `<` `>` `?`
    // `@` `[` `\` `]` `^` `|` DEL. A raw `"` is accepted, so it is absent.
    matches!(byte,
        0x00..=0x20 | 0x23 | 0x25 | 0x2f | 0x3a | 0x3c | 0x3e | 0x3f | 0x40 | 0x5b..=0x5d
            | 0x5e | 0x7c | 0x7f)
}

/// Percent-encode a resolved path for the URL path: `/` separators stay,
/// everything else outside the unreserved ASCII set becomes `%XX`.
fn encode_path(path: &str) -> Cow<'_, str> {
    percent_encode(path, b"/")
}

fn percent_encode<'a>(input: &'a str, extra_allowed: &[u8]) -> Cow<'a, str> {
    fn unreserved(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
    }
    let allowed = |byte: u8| unreserved(byte) || extra_allowed.contains(&byte);
    if input.bytes().all(allowed) {
        return Cow::Borrowed(input);
    }
    let mut encoded = String::with_capacity(input.len());
    for byte in input.bytes() {
        if allowed(byte) {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(char::from_digit(u32::from(byte >> 4), 16).unwrap().to_ascii_uppercase());
            encoded.push(char::from_digit(u32::from(byte & 0xf), 16).unwrap().to_ascii_uppercase());
        }
    }
    Cow::Owned(encoded)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    // Windows `file:` URL handling (issue #744): UNC paths round trip
    // through the URL authority (`\\server\share\a.ts` <->
    // `file://server/share/a.ts`), while drive-letter paths keep the
    // `file:///C:/…` form. The module is compiled into test builds on every
    // platform, so these run wherever `cargo test` does.

    #[test]
    fn windows_drive_url_parses() {
        assert_eq!(url_to_path("file:///C:/a/b.ts"), Some(PathBuf::from("C:/a/b.ts")));
    }

    #[test]
    fn windows_drive_path_generates() {
        assert_eq!(path_to_url("C:\\a\\b.ts"), "file:///C:/a/b.ts");
    }

    #[test]
    fn windows_unc_url_parses_to_unc_path() {
        assert_eq!(
            url_to_path("file://server/share/dir/module.ts"),
            Some(PathBuf::from("\\\\server\\share\\dir\\module.ts"))
        );
    }

    #[test]
    fn windows_unc_url_without_path_parses_to_server_root() {
        assert_eq!(url_to_path("file://server"), Some(PathBuf::from("\\\\server\\")));
    }

    #[test]
    fn windows_unc_url_decodes_escapes() {
        assert_eq!(
            url_to_path("file://server/share/my%20dir/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\my dir\\x.ts"))
        );
        // The authority decodes allowed escapes: `%C3%BD` is the IDNA form
        // of `ý`, so the host is the Unicode name, like `fileURLToPath`.
        assert_eq!(
            url_to_path("file://my%C3%BDserver/share/x.ts"),
            Some(PathBuf::from("\\\\myýserver\\share\\x.ts"))
        );
    }

    #[test]
    fn windows_query_and_fragment_are_not_part_of_the_path() {
        // Node validates and decodes the pathname only; the suffix is module
        // identity, dropped here and re-attached by `create_resolve`.
        assert_eq!(
            url_to_path("file://server/share/a.ts?key=%2F"),
            Some(PathBuf::from("\\\\server\\share\\a.ts"))
        );
        assert_eq!(url_to_path("file:///C:/a.ts#frag%5C"), Some(PathBuf::from("C:/a.ts")));
    }

    #[test]
    fn windows_forbidden_host_escapes_are_rejected() {
        // The URL parser rejects an authority whose escapes decode to
        // forbidden host code points (ERR_INVALID_URL); decoding them here
        // would silently move a path segment into the server name.
        assert_eq!(url_to_path("file://server%5Cother/share/x.ts"), None);
        assert_eq!(url_to_path("file://server%2Fother/share/x.ts"), None);
        assert_eq!(url_to_path("file://my%20server/share/x.ts"), None);
        assert_eq!(url_to_path("file://ser%ver/share/x.ts"), None);
    }

    #[test]
    fn windows_forbidden_host_characters_are_rejected() {
        // Raw forbidden characters meet the same rejection; Node passes the
        // specifier to the hook but its parser refuses the authority.
        for host in [
            "user@server",
            "server:80",
            "server|other",
            "ser<ver",
            "ser>ver",
            "ser^ver",
            "ser[ver",
            "ser]ver",
            "my server",
        ] {
            assert_eq!(url_to_path(&format!("file://{host}/share/x.ts")), None, "{host}");
        }
        // A raw `"` and bracketed IPv6 literals are accepted, matching
        // `fileURLToPath`; brackets around anything that is not IPv6 are
        // rejected like Node's URL parser.
        assert_eq!(
            url_to_path("file://ser\"ver/share/x.ts"),
            Some(PathBuf::from("\\\\ser\"ver\\share\\x.ts"))
        );
        assert_eq!(url_to_path("file://[foo]/share/x.ts"), None);
        assert_eq!(
            url_to_path("file://[::1]/share/x.ts"),
            Some(PathBuf::from("\\\\[::1]\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://[2001:db8::1]/share/x.ts"),
            Some(PathBuf::from("\\\\[2001:db8::1]\\share\\x.ts"))
        );
    }

    #[test]
    fn windows_unc_path_generates_authority_url() {
        assert_eq!(path_to_url("\\\\server\\share\\x.ts"), "file://server/share/x.ts");
        // Forward-slash UNC spellings are accepted as well.
        assert_eq!(path_to_url("//server/share/x.ts"), "file://server/share/x.ts");
        // The host is percent-encoded for the authority.
        assert_eq!(path_to_url("\\\\my server\\share\\x.ts"), "file://my%20server/share/x.ts");
    }

    #[test]
    fn windows_unc_path_escapes_url_significant_characters() {
        // A literal `%` in a file name must not be read back as an escape.
        assert_eq!(path_to_url("\\\\server\\share\\a%20b.ts"), "file://server/share/a%2520b.ts");
        // Neither should `#`, which would start a fragment.
        assert_eq!(path_to_url("\\\\server\\share\\a#b.ts"), "file://server/share/a%23b.ts");
        // Spaces and non-ASCII bytes encode the way `pathToFileURL` encodes.
        assert_eq!(path_to_url("\\\\server\\share\\a b.ts"), "file://server/share/a%20b.ts");
        assert_eq!(path_to_url("\\\\server\\share\\õ.ts"), "file://server/share/%C3%B5.ts");
    }

    #[test]
    fn windows_escaped_unc_path_round_trips() {
        let url = path_to_url("\\\\server\\share\\a%20b.ts");
        assert_eq!(url, "file://server/share/a%2520b.ts");
        assert_eq!(url_to_path(&url), Some(PathBuf::from("\\\\server\\share\\a%20b.ts")));
    }

    #[test]
    fn windows_punycode_host_decodes_to_unicode() {
        // `pathToFileURL('\\\\mýserver\\share\\x')` writes the punycode
        // authority; `fileURLToPath` maps it back through IDNA to-Unicode.
        assert_eq!(
            url_to_path("file://xn--mserver-v2a/share/x.ts"),
            Some(PathBuf::from("\\\\mýserver\\share\\x.ts"))
        );
        // An already-Unicode host is left alone.
        assert_eq!(
            url_to_path("file://m%C3%BDserver/share/x.ts"),
            Some(PathBuf::from("\\\\mýserver\\share\\x.ts"))
        );
        // A label that is not valid punycode, decodes to an all-ASCII name
        // (not a valid U-label, RFC 5890), or decodes to characters
        // DISALLOWED in every IDNA version (controls, non-characters) is
        // kept literal — `domainToUnicode` never decodes these either.
        assert_eq!(
            url_to_path("file://xn--!!!/share/x.ts"),
            Some(PathBuf::from("\\\\xn--!!!\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://xn--a/share/x.ts"),
            Some(PathBuf::from("\\\\xn--a\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://xn--abc-/share/x.ts"),
            Some(PathBuf::from("\\\\xn--abc-\\share\\x.ts"))
        );
        // ASCII hosts take the fast path.
        assert_eq!(
            url_to_path("file://server/share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        // Dots between labels survive the conversion.
        assert_eq!(
            url_to_path("file://xn--mserver-v2a.example.com/share/x.ts"),
            Some(PathBuf::from("\\\\mýserver.example.com\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://server.example.com/share/x.ts"),
            Some(PathBuf::from("\\\\server.example.com\\share\\x.ts"))
        );
    }

    #[test]
    fn windows_hosts_pass_through_uts46_mapping() {
        // UTS #46 canonicalization, like the URL parser applies it:
        // fullwidth and compatibility characters fold to their ASCII forms
        // before the localhost special case and UNC mapping.
        assert_eq!(
            url_to_path("file://ｌｏｃａｌｈｏｓｔ/C:/app.js"),
            Some(PathBuf::from("C:/app.js"))
        );
        assert_eq!(
            url_to_path("file://ｓｅｒｖｅｒ/share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        assert_eq!(url_to_path("file://℡/share/x.ts"), Some(PathBuf::from("\\\\tel\\share\\x.ts")));
    }

    #[test]
    fn windows_mapping_interactions() {
        // UTS #46 runs before IPv4 classification: fullwidth digits map
        // first, and a mapped address that is out of range is rejected.
        assert_eq!(
            url_to_path("file://１２７.１/share/app.js"),
            Some(PathBuf::from("\\\\127.0.0.1\\share\\app.js"))
        );
        assert_eq!(url_to_path("file://２５６.１/share/x.ts"), None);
        // A host whose mapping produces a forbidden character is rejected.
        assert_eq!(url_to_path("file://％/share/x.ts"), None);
        // Disallowed characters and an empty mapping are rejected too; only
        // undecodable xn-- labels keep their literal spelling, per label —
        // a sibling label's failure still rejects the host.
        assert_eq!(url_to_path("file://%E2%80%8D/share/x.ts"), None);
        assert_eq!(url_to_path("file://%C2%AD/share/x.ts"), None);
        assert_eq!(url_to_path("file://xn--1.%E2%80%8D/share/x.ts"), None);
        assert_eq!(url_to_path("file://%C3%A9a%E2%80%8D/share/x.ts"), None);
        assert_eq!(
            url_to_path("file://xn--1/share/x.ts"),
            Some(PathBuf::from("\\\\xn--1\\share\\x.ts"))
        );
        // A leading pipe drive folds without any dot segment present, while
        // a pipe in a later segment stays literal.
        assert_eq!(
            url_to_path("file://server/C|/share/app.js"),
            Some(PathBuf::from("\\\\server\\C:\\share\\app.js"))
        );
        assert_eq!(
            url_to_path("file://server/share/C|/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\C|\\x.ts"))
        );
    }

    #[test]
    fn windows_encoded_separators_are_rejected() {
        // `fileURLToPath` refuses `%5C`/`%2F` with ERR_INVALID_FILE_URL_PATH;
        // decoding them into real separators would let a URL text denote a
        // file outside the directory its path names.
        for escape in ["%5C", "%5c", "%2F", "%2f"] {
            assert_eq!(
                url_to_path(&format!("file://server/share/dir{escape}..{escape}secret.ts")),
                None,
                "{escape} must be rejected"
            );
        }
        assert_eq!(url_to_path("file:///C:/a%5cb.ts"), None);
        assert_eq!(url_to_path("file:///C:/a%2Fb.ts"), None);
        // A valid, unrelated escape is unaffected.
        assert_eq!(
            url_to_path("file://server/share/a%20b.ts"),
            Some(PathBuf::from("\\\\server\\share\\a b.ts"))
        );
    }

    #[test]
    fn windows_verbatim_prefix_is_ignored() {
        // Canonicalized paths carry the extended-length prefix; `pathToFileURL`
        // maps `\\?\UNC\server\share\…` and `\\?\C:\…` to the ordinary forms.
        assert_eq!(path_to_url("\\\\?\\UNC\\server\\share\\x.ts"), "file://server/share/x.ts");
        assert_eq!(path_to_url("\\\\?\\C:\\x.ts"), "file:///C:/x.ts");
        assert_eq!(path_to_url("\\\\server\\share\\x.ts"), "file://server/share/x.ts");
    }

    #[test]
    fn windows_dot_segments_are_normalized() {
        // The URL parser normalizes dot segments before `fileURLToPath`
        // runs; `..` clamps at the share root and never crosses the drive.
        assert_eq!(
            url_to_path("file://server/./share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://server/a/../share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://server/../share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        assert_eq!(url_to_path("file:///C:/a/../b.ts"), Some(PathBuf::from("C:/b.ts")));
        assert_eq!(url_to_path("file:///C:/../x.ts"), Some(PathBuf::from("C:/x.ts")));
        // A trailing dot segment keeps the trailing slash.
        assert_eq!(
            url_to_path("file://server/share/."),
            Some(PathBuf::from("\\\\server\\share\\"))
        );
        // Encoded dot segments normalize the same way — %2e is a dot in the
        // URL parser — while %2E inside a longer segment is a filename char.
        assert_eq!(
            url_to_path("file://server/old/%2E%2E/new/x.ts"),
            Some(PathBuf::from("\\\\server\\new\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://server/old/.%2e/new/x.ts"),
            Some(PathBuf::from("\\\\server\\new\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://server/share/%2E"),
            Some(PathBuf::from("\\\\server\\share\\"))
        );
        assert_eq!(
            url_to_path("file://server/a%2Eb/x.ts"),
            Some(PathBuf::from("\\\\server\\a.b\\x.ts"))
        );
        // A bare encoded double dot is still a double-dot segment: it pops
        // the share, exactly like the literal spelling.
        assert_eq!(
            url_to_path("file://server/share/%2E%2E/x.ts"),
            Some(PathBuf::from("\\\\server\\x.ts"))
        );
        // Backslashes are URL separators too, so dot segments written with
        // them normalize the same way.
        assert_eq!(
            url_to_path("file://server\\a\\..\\share\\x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        assert_eq!(url_to_path("file:///C:\\a\\..\\b.ts"), Some(PathBuf::from("C:/b.ts")));
        assert_eq!(
            url_to_path("file://server\\share\\."),
            Some(PathBuf::from("\\\\server\\share\\"))
        );
        // A decoded `?` is rejected outright: the resolver can keep a `#`
        // literal but not a `?`, and `?` is illegal in Windows file names.
        assert_eq!(url_to_path("file://server/share/coll%3Fide.ts"), None);
        assert_eq!(url_to_path("file:///C:/coll%3Fide.ts"), None);
        // A pipe-form drive segment folds to the colon spelling and `..`
        // cannot pop it, exactly like the URL parser's ordering.
        assert_eq!(
            url_to_path("file://server/C|/../share/app.js"),
            Some(PathBuf::from("\\\\server\\C:\\share\\app.js"))
        );
        assert_eq!(url_to_path("file://server/C|/.."), Some(PathBuf::from("\\\\server\\C:\\")));
        assert_eq!(url_to_path("file:///C|/../x.ts"), Some(PathBuf::from("C:/x.ts")));
        // A real query is still module identity, not part of the path.
        assert_eq!(
            url_to_path("file://server/share/a.ts?key=%2F"),
            Some(PathBuf::from("\\\\server\\share\\a.ts"))
        );
    }

    #[test]
    fn windows_ipv6_host_keeps_its_authority_syntax() {
        // `pathToFileURL` emits bracketed IPv6 authorities verbatim and
        // canonicalized; percent-encoding the brackets is ERR_INVALID_URL in
        // Node.
        assert_eq!(path_to_url("\\\\[::1]\\share\\x.ts"), "file://[::1]/share/x.ts");
        assert_eq!(path_to_url("\\\\[0:0:0:0:0:0:0:1]\\share\\x.ts"), "file://[::1]/share/x.ts");
        assert_eq!(
            url_to_path("file://[0:0:0:0:0:0:0:1]/share/x.ts"),
            Some(PathBuf::from("\\\\[::1]\\share\\x.ts"))
        );
        // IPv4-mapped addresses serialize as plain hex groups, not dotted quad.
        assert_eq!(
            url_to_path("file://[::ffff:192.168.0.1]/share/x.ts"),
            Some(PathBuf::from("\\\\[::ffff:c0a8:1]\\share\\x.ts"))
        );
        assert_eq!(
            path_to_url("\\\\[::ffff:192.168.0.1]\\share\\x.ts"),
            "file://[::ffff:c0a8:1]/share/x.ts"
        );
        assert_eq!(
            path_to_url("\\\\[2001:db8::1]\\share\\x.ts"),
            "file://[2001:db8::1]/share/x.ts"
        );
    }

    #[test]
    fn windows_backslashes_are_url_separators() {
        // The URL parser normalizes `\` to `/` in special schemes, so a
        // specifier written with Windows separators still splits into
        // authority and path.
        assert_eq!(
            url_to_path("file://server\\share\\x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://server\\share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        // Encoded separators are still rejected in this spelling.
        assert_eq!(url_to_path("file://server\\share%5C..%5Csecret.ts"), None);
    }

    #[test]
    fn windows_localhost_authority_maps_to_drive_path() {
        assert_eq!(url_to_path("file://localhost/C:/a.ts"), Some(PathBuf::from("C:/a.ts")));
        // The parser canonicalizes the authority before `fileURLToPath` sees
        // it, so escapes and case do not defeat the localhost special case.
        assert_eq!(url_to_path("file://%6cocalhost/C:/a.ts"), Some(PathBuf::from("C:/a.ts")));
        assert_eq!(url_to_path("file://LOCALHOST/C:/a.ts"), Some(PathBuf::from("C:/a.ts")));
        // The localhost form still has to name a drive; the `c|` spelling
        // normalizes only with a separator (or nothing) after the pipe —
        // `C|foo.ts` is rejected — and only a literal `:` survives decoding.
        assert_eq!(url_to_path("file://localhost/c|/a.ts"), Some(PathBuf::from("c:/a.ts")));
        assert_eq!(url_to_path("file://localhost/c|"), Some(PathBuf::from("c:")));
        assert_eq!(url_to_path("file://localhost/c|foo.ts"), None);
        assert_eq!(url_to_path("file://localhost/%43%3A/a.ts"), Some(PathBuf::from("C:/a.ts")));
        assert_eq!(url_to_path("file://localhost/C%3A/a.ts"), Some(PathBuf::from("C:/a.ts")));
        assert_eq!(url_to_path("file://localhost/c%7C/a.ts"), None);
        assert_eq!(url_to_path("file://localhost/share/a.ts"), None);
        assert_eq!(url_to_path("file://localhost/"), None);
    }

    #[test]
    fn windows_scheme_is_case_insensitive() {
        // URL schemes are case-insensitive: `FILE://…` is a file URL, and
        // the parser's tab/newline removal applies to the scheme too.
        assert_eq!(
            url_to_path("FILE://server/share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        assert_eq!(url_to_path("fIlE:///C:/a.ts"), Some(PathBuf::from("C:/a.ts")));
        assert_eq!(
            url_to_path("fi\tle://server/share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
    }

    #[test]
    fn windows_tabs_and_newlines_are_stripped() {
        // The URL parser removes ASCII tab/newline characters everywhere
        // before parsing, in the authority and the path alike.
        for escape in ['\t', '\n', '\r'] {
            assert_eq!(
                url_to_path(&format!("file://ser{escape}ver/sh{escape}are/x.ts")),
                Some(PathBuf::from("\\\\server\\share\\x.ts")),
                "{escape:?} must be stripped"
            );
        }
    }

    #[test]
    fn windows_ipv4_authorities_are_canonicalized() {
        // WHATWG IPv4 parsing: partial and non-decimal spellings
        // canonicalize, anything ending in a number that is not valid IPv4
        // is ERR_INVALID_URL.
        assert_eq!(
            url_to_path("file://127.1/share/x.ts"),
            Some(PathBuf::from("\\\\127.0.0.1\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://1.2.3/share/x.ts"),
            Some(PathBuf::from("\\\\1.2.0.3\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://0x7f.1/share/x.ts"),
            Some(PathBuf::from("\\\\127.0.0.1\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://0177.0.0.1/share/x.ts"),
            Some(PathBuf::from("\\\\127.0.0.1\\share\\x.ts"))
        );
        // A bare hex or octal prefix is numeric zero.
        assert_eq!(
            url_to_path("file://0x/share/x.ts"),
            Some(PathBuf::from("\\\\0.0.0.0\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://0X.1/share/x.ts"),
            Some(PathBuf::from("\\\\0.0.0.1\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://00/share/x.ts"),
            Some(PathBuf::from("\\\\0.0.0.0\\share\\x.ts"))
        );
        // A single trailing dot drops for classification: FQDNs keep it,
        // numeric hosts canonicalize, a double dot is an ordinary hostname.
        assert_eq!(
            url_to_path("file://server.example./share/x.ts"),
            Some(PathBuf::from("\\\\server.example.\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://127.1./share/x.ts"),
            Some(PathBuf::from("\\\\127.0.0.1\\share\\x.ts"))
        );
        assert_eq!(
            url_to_path("file://1.2.3.4../share/x.ts"),
            Some(PathBuf::from("\\\\1.2.3.4..\\share\\x.ts"))
        );
        // A syntactically numeric label with an invalid value is rejected.
        assert_eq!(url_to_path("file://09/share/x.ts"), None);
        assert_eq!(url_to_path("file://256.1/share/x.ts"), None);
        assert_eq!(url_to_path("file://1.2.3.4.5/share/x.ts"), None);
        assert_eq!(url_to_path("file://server.256.1/share/x.ts"), None);
        assert_eq!(url_to_path("file://1.2.3.256/share/x.ts"), None);
        // A name that merely ends in a digit is not IPv4.
        assert_eq!(
            url_to_path("file://server1/share/x.ts"),
            Some(PathBuf::from("\\\\server1\\share\\x.ts"))
        );
    }

    #[test]
    fn windows_authority_is_lowercased() {
        assert_eq!(
            url_to_path("file://SERVER/share/x.ts"),
            Some(PathBuf::from("\\\\server\\share\\x.ts"))
        );
        // Punycode decodes after lowercasing, like the URL parser plus
        // `domainToUnicode`.
        assert_eq!(
            url_to_path("file://XN--MSERVER-V2A/share/x.ts"),
            Some(PathBuf::from("\\\\mýserver\\share\\x.ts"))
        );
    }

    #[test]
    fn non_file_urls_are_rejected() {
        assert_eq!(url_to_path("https://example.com/x.ts"), None);
        assert_eq!(url_to_path("node:fs"), None);
    }

    #[test]
    fn windows_malformed_escapes_are_rejected() {
        // Node's `fileURLToPath` runs `decodeURIComponent`, which throws on
        // a malformed escape (URIError), on both the UNC and drive forms.
        assert_eq!(url_to_path("file://server/share/a%zz.ts"), None);
        assert_eq!(url_to_path("file:///C:/a%zz.ts"), None);
        assert_eq!(url_to_path("file:///C:/a%"), None);
    }

    #[test]
    fn windows_drive_letter_authority_folds_into_path() {
        // The URL parser folds a drive-letter authority back into the path
        // (`file://C:/app.ts` is `file:///C:/app.ts`); the `c|` spelling
        // normalizes to `c:`.
        assert_eq!(url_to_path("file://C:/app.ts"), Some(PathBuf::from("C:/app.ts")));
        assert_eq!(url_to_path("file://c|/app.ts"), Some(PathBuf::from("c:/app.ts")));
        assert_eq!(url_to_path("file://C:"), Some(PathBuf::from("C:")));
        assert_eq!(url_to_path("file://g:/dir/app.ts"), Some(PathBuf::from("g:/dir/app.ts")));
    }

    #[test]
    fn invalid_utf8_escapes_are_rejected() {
        assert_eq!(url_to_path("file:///a%FF.ts"), None);
        assert_eq!(url_to_path("file://server/share/%FF.ts"), None);
    }
}
