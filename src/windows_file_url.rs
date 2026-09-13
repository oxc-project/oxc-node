//! Windows `file:` URL rules (issue #744): a UNC path round trips through the
//! URL authority — `\\server\share\a.ts` <-> `file://server/share/a.ts` —
//! while a drive-letter path keeps the `file:///C:/…` form. Compiled into
//! test builds on every platform so the matrix below runs wherever `cargo
//! test` does; production builds on other platforms exclude it entirely.

use std::borrow::Cow;
use std::path::PathBuf;

use super::percent_decode;

/// Convert a `file://` URL into a filesystem path: `file:///C:/…` keeps
/// the drive form, and `file://server/share/…` maps its authority back to
/// a leading `\\server\…`, the same reading `fileURLToPath` gives it.
/// Returns `None` for non-`file:` URLs and escapes that do not decode to
/// valid UTF-8.
pub(super) fn url_to_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    if rest.is_empty() {
        return None;
    }
    // The query and fragment are not part of the filesystem path — Node
    // validates and decodes the pathname only — so split them off before the
    // separator checks and pass the raw suffix through for the resolver to
    // treat as module identity.
    let (rest, suffix) = match rest.find(['?', '#']) {
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
        return decode_path(&path, suffix);
    }
    // Drive form: `file:///C:/a/b` — the slash after the scheme anchors
    // the drive letter, and stripping it leaves `C:/a/b` where it belongs.
    if let Some(path) = rest.strip_prefix('/') {
        return decode_path(path, suffix);
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
    if has_forbidden_host_escape(host) || has_forbidden_host_char(host) {
        return None;
    }
    let host = percent_decode(host)?;
    // `pathToFileURL` writes a non-ASCII server name as punycode, and
    // `fileURLToPath` runs the host through IDNA to-Unicode
    // (`domainToUnicode`) — `\\mýserver\share` round trips as
    // `file://xn--mserver-v2a/share`. Match that, or the decoded host
    // names a server nobody has. The URL parser also lowercases and
    // canonicalizes the authority first, so `file://%6cocalhost/C:/…`
    // is the local drive path just like `file://localhost/C:/…`.
    let host = domain_to_unicode(&host);
    if host.eq_ignore_ascii_case("localhost") {
        return decode_path(path, suffix);
    }
    let path = decode_path_string(path)?;
    let mut unc = String::with_capacity(host.len() + path.len() + suffix.len() + 3);
    unc.push_str("\\\\");
    unc.push_str(&host);
    unc.push('\\');
    unc.push_str(&path.replace('/', "\\"));
    unc.push_str(suffix);
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

/// Percent-encode a UNC server name for the URL authority: every byte
/// outside the unreserved ASCII set becomes `%XX` with uppercase hex,
/// matching what `pathToFileURL` writes for a host such as `my server`.
fn encode_host(host: &str) -> Cow<'_, str> {
    percent_encode(host, &[])
}

/// IDNA to-Unicode for a UNC host, the conversion `fileURLToPath` applies
/// through `domainToUnicode`: `xn--` labels are punycode-decoded, labels
/// that do not decode are kept as-is, and non-ASCII input is untouched —
/// the URL parser has already mapped those labels to their punycode form.
fn domain_to_unicode(host: &str) -> Cow<'_, str> {
    if !host.is_ascii() {
        return Cow::Borrowed(host);
    }
    // The URL parser canonicalizes the authority to lowercase before
    // `fileURLToPath` maps it back, so uppercase never survives.
    let host = if host.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Owned(host.to_ascii_lowercase())
    } else {
        Cow::Borrowed(host)
    };
    let mut decoded = String::with_capacity(host.len());
    let mut changed = false;
    let mut first_label = true;
    for label in host.split('.') {
        if !first_label {
            decoded.push('.');
        }
        first_label = false;
        if label.len() > 4
            && label[..4].eq_ignore_ascii_case("xn--")
            && let Some(unicode) = punycode_decode(&label[4..])
        {
            decoded.push_str(&unicode);
            changed = true;
            continue;
        }
        decoded.push_str(label);
    }
    if changed { Cow::Owned(decoded) } else { host }
}

/// Percent-decode a URL path and re-attach the raw query/fragment suffix,
/// refusing the encoded separators that `fileURLToPath` rejects with
/// `ERR_INVALID_FILE_URL_PATH`: a `%5C` or `%2F` that became a real
/// separator after decoding would let the URL text denote a file outside
/// the directory its path names. The suffix is validated separately by
/// Node, so escapes inside it stay untouched.
fn decode_path(path: &str, suffix: &str) -> Option<PathBuf> {
    let decoded = decode_path_string(path)?;
    let mut path = decoded.into_owned();
    path.push_str(suffix);
    Some(PathBuf::from(path))
}

/// Percent-decode a URL path, refusing the escapes `fileURLToPath`
/// rejects: `%5C`/`%2F` become real separators and would let the URL text
/// denote a file outside the directory its path names, and a malformed
/// escape makes Node's `decodeURIComponent` throw.
fn decode_path_string(path: &str) -> Option<Cow<'_, str>> {
    let bytes = path.as_bytes();
    let mut search_from = 0;
    while let Some(relative) = bytes[search_from..].iter().position(|&byte| byte == b'%') {
        let index = search_from + relative;
        match hex_byte(bytes, index) {
            Some(0x2f | 0x5c) => return None,
            Some(_) => search_from = index + 3,
            None => return None,
        }
    }
    percent_decode(path)
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
/// keep their `:`, which is otherwise forbidden.
fn has_forbidden_host_char(host: &str) -> bool {
    if host.len() > 2 && host.starts_with('[') && host.ends_with(']') {
        // The bracket exception holds only for genuine IPv6 literals —
        // `file://[foo]/…` is ERR_INVALID_URL in Node, and the fallback
        // below rejects the brackets as forbidden characters.
        let address = host[1..host.len() - 1].split('%').next().unwrap_or_default();
        if address.parse::<std::net::Ipv6Addr>().is_ok() {
            return false;
        }
    }
    // `%` is legal inside a valid escape and policed by
    // `has_forbidden_host_escape` instead — malformed there, forbidden when
    // it decodes to a `%`.
    host.bytes().any(|byte| byte != b'%' && forbidden_host_byte(byte))
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

/// RFC 3492 punycode decode. `None` on malformed input or overflow, so a
/// hostile host can never panic the loader — the caller falls back to the
/// literal label.
fn punycode_decode(input: &str) -> Option<String> {
    const BASE: u32 = 36;
    const TMIN: u32 = 1;
    const TMAX: u32 = 26;
    const INITIAL_BIAS: u32 = 72;
    const INITIAL_N: u32 = 128;

    let mut n = INITIAL_N;
    let mut i: u32 = 0;
    let mut bias = INITIAL_BIAS;
    let mut output: Vec<char> = Vec::with_capacity(input.len());

    // Code points before the last delimiter are copied verbatim; an
    // absent delimiter means the whole input is the encoded section.
    let input: Vec<char> = input.chars().collect();
    let encoded = match input.iter().rposition(|&c| c == '-') {
        Some(index) => {
            output.extend_from_slice(&input[..index]);
            &input[index + 1..]
        }
        None => &input[..],
    };

    let mut index = 0;
    while index < encoded.len() {
        let old_i = i;
        let mut w: u32 = 1;
        let mut k = BASE;
        loop {
            let digit = match encoded.get(index) {
                Some(&c) => {
                    index += 1;
                    decode_digit(c)?
                }
                None => return None,
            };
            i = i.checked_add(digit.checked_mul(w)?)?;
            let t = if k <= bias {
                TMIN
            } else if k >= bias + TMAX {
                TMAX
            } else {
                k - bias
            };
            if digit < t {
                break;
            }
            w = w.checked_mul(BASE - t)?;
            k += BASE;
        }
        let out_len = (output.len() as u32).checked_add(1)?;
        bias = adapt(i - old_i, out_len, old_i == 0);
        n = n.checked_add(i / out_len)?;
        i %= out_len;
        output.insert(i as usize, char::from_u32(n)?);
        i += 1;
    }

    let mut decoded = String::with_capacity(output.len());
    decoded.extend(output);
    Some(decoded)
}

fn decode_digit(c: char) -> Option<u32> {
    match c {
        '0'..='9' => Some(u32::from(c) - u32::from('0') + 26),
        'a'..='z' => Some(u32::from(c) - u32::from('a')),
        'A'..='Z' => Some(u32::from(c) - u32::from('A')),
        _ => None,
    }
}

fn adapt(mut delta: u32, num_points: u32, first: bool) -> u32 {
    const BASE: u32 = 36;
    const TMIN: u32 = 1;
    const TMAX: u32 = 26;
    const SKEW: u32 = 38;
    const DAMP: u32 = 700;
    delta = if first { delta / DAMP } else { delta / 2 };
    delta += delta / num_points;
    let mut k = 0;
    while delta > ((BASE - TMIN) * TMAX) / 2 {
        delta /= BASE - TMIN;
        k += BASE;
    }
    k + ((BASE - TMIN + 1) * delta) / (delta + SKEW)
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
    fn windows_query_and_fragment_pass_through() {
        // Node validates and decodes the pathname only; the raw suffix is
        // module identity and its escapes are not filesystem separators.
        assert_eq!(
            url_to_path("file://server/share/a.ts?key=%2F"),
            Some(PathBuf::from("\\\\server\\share\\a.ts?key=%2F"))
        );
        assert_eq!(url_to_path("file:///C:/a.ts#frag%5C"), Some(PathBuf::from("C:/a.ts#frag%5C")));
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
        // A label that is not valid punycode falls back to the literal text.
        assert_eq!(
            url_to_path("file://xn--!!!/share/x.ts"),
            Some(PathBuf::from("\\\\xn--!!!\\share\\x.ts"))
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
