use std::{
    borrow::Cow,
    cell::{OnceCell, RefCell},
    collections::{HashMap, HashSet},
    env,
    ffi::OsStr,
    fs, io, iter, mem,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex, OnceLock, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use oxc::{
    allocator::{Allocator, CloneIn, TakeIn},
    ast::ast::{
        Argument, ArrowFunctionExpression, AwaitExpression, Class, Decorator, Expression,
        ForOfStatement, ImportDeclarationSpecifier, Program, Statement, StringLiteral,
        TSExternalModuleDeclaration, TSGlobalDeclaration, TSNamespaceDeclaration, TemplateLiteral,
        VariableDeclaration,
    },
    ast_visit::{Visit, VisitMut, walk},
    codegen::{Codegen, CodegenOptions, CodegenReturn},
    diagnostics::{
        Diagnostics, GraphicalReportHandler, GraphicalTheme, NamedSource, OxcDiagnostic,
    },
    parser::{Parser, ParserReturn},
    semantic::SemanticBuilder,
    span::{SPAN, SourceType, Span},
    syntax::{module_record::ModuleRecord, scope::ScopeFlags},
    transformer::{
        ClassPropertiesOptions, CompilerAssumptions, DecoratorOptions, ES2022Options,
        ES2026Options, EnvOptions, HelperLoaderOptions, JsxOptions, JsxRuntime, Module,
        ProposalOptions, RewriteExtensionsMode, TransformOptions, Transformer, TransformerReturn,
        TypeScriptOptions,
    },
    transformer_plugins::ModuleRunnerTransform,
};
use oxc_resolver::{
    CompilerOptions, EnforceExtension, FileMetadata, FileSystem, FileSystemOs, ModuleType,
    PackageType, Resolution, ResolveContext as ResolverContext, ResolveError, ResolveOptions,
    ResolverGeneric, TsConfig, TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
};
use oxc_sourcemap::{SourceMap, Token};
use phf::Set;

#[cfg(all(
    not(target_arch = "x86"),
    not(target_arch = "arm"),
    not(target_family = "wasm"),
    not(all(target_os = "windows", target_arch = "aarch64")),
    feature = "napi",
    not(feature = "default_global_allocator")
))]
#[global_allocator]
static ALLOC: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

const BUILTIN_MODULES: Set<&str> = phf::phf_set! {
    "_http_agent",
    "_http_client",
    "_http_common",
    "_http_incoming",
    "_http_outgoing",
    "_http_server",
    "_stream_duplex",
    "_stream_passthrough",
    "_stream_readable",
    "_stream_transform",
    "_stream_wrap",
    "_stream_writable",
    "_tls_common",
    "_tls_wrap",
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "dns/promises",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "timers",
    "timers/promises",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "util/types",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
};

/// Where the `tsconfig.json` that applies to a given source file comes from.
///
/// `oxc_resolver` offers two discovery strategies and they are not
/// interchangeable, so the strategy chosen at startup has to be remembered:
///
/// * [`TsconfigDiscovery::Manual`] pins one config for the loader context. It is
///   also the only mode that [`Resolver::resolve`] consults, because that API
///   goes through `manual_tsconfig()` internally.
/// * [`TsconfigDiscovery::Auto`] resolves a config per file, and [`Resolver::resolve`]
///   ignores it entirely. Only [`Resolver::find_tsconfig`] sees it, so under `Auto`
///   the config is looked up here and handed to `resolve_with_context`.
enum TsconfigSource {
    /// An explicit config requested through [`set_tsconfig_path`],
    /// `TS_NODE_PROJECT` or `OXC_TSCONFIG_PATH`. The exact same config applies
    /// to every file, including files inside `node_modules`.
    ///
    /// `None` means the requested path does not exist. That deliberately leaves
    /// the loader context with no config at all instead of falling back to discovery:
    /// somebody who names a config file explicitly does not want a different
    /// one silently substituted.
    Manual(Option<Arc<TsConfig>>),
    /// No config was requested explicitly, so each file gets the nearest
    /// ancestor `tsconfig.json` that actually claims it.
    ///
    /// This is what lets a file in a sub-project with no `tsconfig.json` of its
    /// own inherit the workspace root config, while still respecting
    /// `files` / `include` / `exclude` and project `references`: a root config
    /// whose `include` does not cover the file is skipped rather than applied.
    Auto,
}

/// Extensions that TypeScript only treats as program inputs when `allowJs` is on.
const JS_EXTENSIONS: [&str; 4] = ["js", "jsx", "mjs", "cjs"];

/// The outcome of [`TsconfigSource::walk_nearest`].
enum Nearest {
    /// A usable config answers for the tree.
    Found(Arc<TsConfig>),
    /// No ancestor has a `tsconfig.json`.
    NotFound,
    /// The nearest config exists but does not parse; never memoized, so a
    /// corrected config is retried on the next resolution.
    Unusable,
}

impl TsconfigSource {
    /// The `tsconfig.json` that governs `path`, if any, by strict ownership.
    ///
    /// This is the answer used for everything that changes emitted code — the
    /// transform API, the load hook, and the module-format decision. A config
    /// that does not claim the file does not get to compile it, which is the
    /// whole point of honouring `files` / `include` / `exclude`.
    ///
    /// `path` must be an absolute file path (not a `file://` URL); the resolver
    /// returns `None` for anything else.
    fn for_path(&self, resolver: &Resolver, path: &Path) -> Option<Arc<TsConfig>> {
        match self {
            Self::Manual(tsconfig) => tsconfig.clone(),
            Self::Auto => Self::discover(resolver, path),
        }
    }

    /// The `tsconfig.json` whose `paths` and `baseUrl` an importer's specifiers
    /// resolve against — [`Self::for_path`], plus a fallback for JavaScript and
    /// a nearest-ancestor fallback for bare specifiers from files no config
    /// claims at all.
    ///
    /// `oxc_resolver` applies TypeScript's own program-membership rule:
    /// `is_file_included_in_tsconfig` calls `is_extensionless_or_uncompiled_js`,
    /// which rejects `js` / `jsx` / `mjs` / `cjs` outright unless `allowJs` is
    /// set. So no config ever claims a plain JavaScript file, and such a file
    /// would silently lose every path alias and fail to resolve at runtime.
    ///
    /// But "is this file an input to the TypeScript program" is not the question
    /// being asked here. The question is "which project does this file belong to,
    /// **for the purpose of module resolution**", and a `.mjs` file sitting in
    /// `src/` resolves its imports the same way its `.ts` neighbours do. So when
    /// nothing claims a JavaScript file, ask again as if it were TypeScript.
    ///
    /// This deliberately stops at resolution and must never be used to pick
    /// compiler options. A config saying `exclude: ["src/**/*.js"]` has said, in
    /// as many words, that those files are not its program; applying its
    /// `experimentalDecorators` or `useDefineForClassFields` to them anyway
    /// would break the ownership rule this whole discovery scheme exists to
    /// honour. Keep the two lookups separate.
    ///
    /// When nothing claims the file at all — a script outside every `include`,
    /// the common `scripts/` directory next to a root config covering only
    /// `src/` — the last resort is the nearest ancestor `tsconfig.json`,
    /// whether or not it claims the file. That is the answer tsx gives to
    /// "which project does this file belong to", and it stays resolution-only
    /// for the same reason the probe does. `exclude` deliberately does not gate
    /// resolution either: tsx resolves a config's aliases for files `exclude`
    /// names, and only compiler options honour `exclude`, through
    /// [`Self::for_path`].
    ///
    /// The nearest-ancestor fallback serves bare package specifiers only.
    /// `paths` and `baseUrl` never match a `.`-prefixed specifier, and the one
    /// thing a tsconfig context adds to relative resolution in oxc_resolver is
    /// `rootDirs` (`resolve_tsconfig_compiler_options`), which tsx does not
    /// implement at all. Rooted and scheme-prefixed specifiers name a concrete
    /// target owned by Node.js or another loader, yet `resolve_with_context`
    /// tries `paths` first, so a catch-all mapping could redirect them;
    /// [`is_bare_specifier`] spells out the exact set, which is deliberately
    /// broader than tsx's gate for schemes.
    ///
    /// The probe path never has to exist: `claims_ownership_of` only matches
    /// `files` / `include` / `exclude` globs and project references against the
    /// string, and stats nothing but the candidate `tsconfig.json` files it walks
    /// past.
    fn for_importer(
        &self,
        resolver: &Resolver,
        path: &Path,
        specifier: &str,
    ) -> Option<Arc<TsConfig>> {
        match self {
            // An explicitly named config already applies to every file, so there
            // is nothing for the probe to recover.
            Self::Manual(tsconfig) => tsconfig.clone(),
            Self::Auto => Self::discover(resolver, path)
                .or_else(|| {
                    Self::probe_as_typescript(path)
                        .and_then(|probe| Self::discover(resolver, &probe))
                        .inspect(
                            |_| tracing::debug!(path = ?path, "tsconfig found via TypeScript probe"),
                        )
                })
                // See the doc comment above for why the nearest-ancestor
                // fallback serves bare package specifiers only.
                .or_else(|| {
                    if is_bare_specifier(specifier) {
                        Self::nearest(resolver, path).inspect(
                            |_| tracing::debug!(path = ?path, "tsconfig found as the nearest ancestor"),
                        )
                    } else {
                        None
                    }
                }),
        }
    }

    /// Ask the resolver which `tsconfig.json` claims `path`.
    ///
    /// `find_tsconfig` walks up from the file's own directory, skips anything
    /// that is not a readable file (so a *directory* named `tsconfig.json` does
    /// not stop the walk), caches per directory and per path, and returns `None`
    /// inside `node_modules`. A broken config somewhere up the tree is reported
    /// as an error; treat that as "no config" so that one bad ancestor cannot
    /// break every transform and every resolution below it.
    ///
    /// `find_tsconfig` also parses its argument as a specifier, so a `#` in
    /// the path would cut it short (`/p#1/src/main.tsx` reads as `/p`) and
    /// discovery would walk up from a directory nobody has. The resolver's
    /// `\0#` escape keeps the hash a file-name character. It is only applied
    /// to ASCII paths without `?`: the resolver drops the escape byte by byte,
    /// mangling multi-byte characters, and `?` has no escape at all.
    fn discover(resolver: &Resolver, path: &Path) -> Option<Arc<TsConfig>> {
        let original = path;
        let escaped;
        // Whether the resolver walks up from `path` itself rather than from
        // a truncated or lossily converted one.
        let mut faithful = true;
        let path = match path.to_str() {
            Some(text) => {
                let hash = memchr::memchr(b'#', text.as_bytes()).is_some();
                let query = memchr::memchr(b'?', text.as_bytes()).is_some();
                if hash && text.is_ascii() && !query {
                    escaped = PathBuf::from(text.replace('#', "\u{0}#"));
                    escaped.as_path()
                } else {
                    faithful = !hash && !query;
                    path
                }
            }
            None => {
                faithful = false;
                path
            }
        };
        let found = resolver.find_tsconfig(path);
        // Scanning a chain the walk never saw could report a config it never
        // skipped, so a path it cannot represent goes unscanned.
        if faithful {
            Self::warn_skipped_unreadable(resolver, original, &found);
        }
        match found {
            Ok(tsconfig) => tsconfig,
            Err(err) => {
                tracing::debug!(path = ?path, error = ?err, "failed to discover tsconfig");
                // Ignoring a broken config is what keeps one bad ancestor from failing
                // every file, but doing it silently hides why `paths` stopped applying
                // (issue #844).
                warn_once(format!("{}; ignoring it", describe_tsconfig_error(&err)));
                None
            }
        }
    }

    /// Report each ancestor `tsconfig.json` that `find_tsconfig` walked past
    /// because it could not be read (permission denied, any I/O error); the
    /// resolver skips those without returning an error (issue #844).
    ///
    /// The walk passed every candidate below the directory it stopped in: the
    /// one holding the config it returned or failed on, or none at all when no
    /// config claims the file. A config resolved through a project reference
    /// does not say which ancestor referenced it, so then the scan stops at the
    /// first config it can read, which may report fewer than were skipped but
    /// never one the walk did not reach. The outcome depends on the file, as
    /// ownership does. A successful lookup is cached by the resolver, which
    /// then never walks that chain again, so such a file is scanned once; a
    /// failed one is retried, so it is scanned again each time.
    fn warn_skipped_unreadable(
        resolver: &Resolver,
        path: &Path,
        found: &std::result::Result<Option<Arc<TsConfig>>, ResolveError>,
    ) {
        static SCANNED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);
        if !path.is_absolute() || path.components().any(|c| c.as_os_str() == "node_modules") {
            return;
        }
        let Some(directory) = path.parent() else {
            return;
        };
        let stop = match found {
            Ok(Some(tsconfig)) => tsconfig.path().parent(),
            Err(ResolveError::TsconfigLoadFailed { path, .. }) => path.parent(),
            Ok(None) | Err(_) => None,
        };
        // Only a stop in the ancestor chain is one the walk can have reached.
        let stop = stop.filter(|stop| directory.starts_with(stop));
        if found.is_ok()
            && !SCANNED.lock().unwrap_or_else(PoisonError::into_inner).insert(path.to_path_buf())
        {
            return;
        }
        // A config found through a reference leaves no stop in the chain, and
        // then only the first config the scan can use is certainly reached.
        let conservative = stop.is_none() && matches!(found, Ok(Some(_)));
        for dir in directory.ancestors() {
            if Some(dir) == stop {
                return;
            }
            let candidate = dir.join("tsconfig.json");
            if !is_tsconfig_file(&candidate) {
                continue;
            }
            // A config that fails to load for any other reason is where a failed
            // walk stopped, and every config below it that loads did not claim the
            // file, or the walk would have stopped there instead.
            match resolver.resolve_tsconfig(&candidate) {
                Err(err) if is_io_failure(&err) => warn_unreadable(&err),
                Ok(_) if !conservative => {}
                _ => return,
            }
        }
    }

    /// The same path with a `.ts` extension, for a JavaScript-family file only.
    ///
    /// See [`Self::for_importer`], the sole caller, for why this exists.
    fn probe_as_typescript(path: &Path) -> Option<PathBuf> {
        let extension = path.extension()?.to_str()?;
        JS_EXTENSIONS.contains(&extension).then(|| path.with_extension("ts"))
    }

    /// The nearest ancestor `tsconfig.json`, whether or not it claims `path`.
    ///
    /// Resolution-only fallback for bare specifiers of importers no config
    /// claims (a script outside every `include`), matching tsx, which applies
    /// the found config's `paths` to every importer outside node_modules —
    /// including files `exclude` names. It runs after discovery and the
    /// JavaScript probe, so a config that claims the file always wins; it is
    /// never consulted for compiler options ([`Self::for_path`] keeps strict
    /// ownership) nor for specifiers that name a concrete target
    /// ([`is_bare_specifier`], see [`Self::for_importer`]).
    ///
    /// The outcome is memoized per importer directory in the loader context;
    /// `resolve_tsconfig` parses, builds and caches the config, so repeated
    /// imports from the same tree cost one parse and one walk. A broken config
    /// is handled exactly as [`Self::discover`] handles it, through
    /// `find_tsconfig_auto`: an unreadable one (permission denied, any I/O
    /// error) is skipped and the walk continues to a grandparent, while an
    /// unparseable one is treated as "no config" and stops the walk — never
    /// walk past it to a grandparent — and the failure is not memoized, so a
    /// corrected config is picked up on the next resolution.
    fn nearest(resolver: &Resolver, path: &Path) -> Option<Arc<TsConfig>> {
        // No paths resolution for dependencies, matching both tsx's dependency
        // gate and `find_tsconfig`, which returns None inside node_modules.
        // Without this guard the ancestor walk would escape node_modules and
        // hand a dependency the workspace root's aliases.
        if path.components().any(|c| c.as_os_str() == "node_modules") {
            return None;
        }
        // The walk depends only on the directory's ancestor chain (`skip(1)`
        // drops the file name), so one entry covers every importer in it.
        let directory = path.parent()?;
        let context = loader_context();
        if let Some(cached) =
            context.nearest_tsconfig.lock().unwrap_or_else(PoisonError::into_inner).get(directory)
        {
            return cached.clone();
        }
        let found = Self::walk_nearest(resolver, path);
        if let Nearest::Unusable = found {
            return None;
        }
        let outcome = match found {
            Nearest::Found(tsconfig) => Some(tsconfig),
            Nearest::NotFound | Nearest::Unusable => None,
        };
        context
            .nearest_tsconfig
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(directory.to_path_buf(), outcome.clone());
        outcome
    }

    /// The ancestor walk behind [`Self::nearest`], before memoization.
    fn walk_nearest(resolver: &Resolver, path: &Path) -> Nearest {
        for candidate in path.ancestors().skip(1).map(|dir| dir.join("tsconfig.json")) {
            if !is_tsconfig_file(&candidate) {
                continue;
            }
            match resolver.resolve_tsconfig(&candidate) {
                Ok(tsconfig) => return Nearest::Found(tsconfig),
                // `find_tsconfig_auto` skips a tsconfig that fails with an I/O
                // error and keeps walking; do the same here.
                Err(err) if is_io_failure(&err) => {
                    tracing::debug!(
                        path = ?path,
                        error = ?err,
                        "nearest tsconfig.json is unreadable; walking on"
                    );
                    warn_unreadable(&err);
                }
                Err(err) => {
                    tracing::debug!(path = ?path, error = ?err, "nearest tsconfig.json is not usable");
                    // Worded as `discover` words it, so a config both reject is
                    // reported once.
                    warn_once(format!("{}; ignoring it", describe_tsconfig_error(&err)));
                    return Nearest::Unusable;
                }
            }
        }
        Nearest::NotFound
    }
}

/// Whether `specifier` is a bare package specifier (`lodash`, `@lib/x.ts`,
/// `#dep`) rather than one naming a concrete target: relative (`./x`), rooted
/// (`/x`), or scheme-prefixed (`file:/x`, `https://…`, `virtual:module`).
/// The scheme rule is deliberately broader than tsx's gate (which excludes
/// only `scheme://` plus `data:`/`file:`/`node:`): a scheme is owned by
/// Node.js or by another loader in the chain, and `paths` trying first would
/// steal the specifier from its owner. Windows adds two concrete forms with
/// no equivalent elsewhere — `\`-rooted or UNC paths and drive prefixes
/// (`C:\x`) — and a drive is just a one-letter scheme to the check below, so
/// only the `\` test is compiled conditionally. Classification follows
/// WHATWG URL whitespace normalization (trimmed C0 controls/spaces, dropped
/// tab/newline), since Node.js applies it before scheme detection.
///
/// Only bare specifiers may consult a tsconfig's `paths`: a concrete target
/// names a file, and `resolve_with_context` tries `paths` before absolute
/// resolution, so a catch-all mapping like `"*": ["src/shim.ts"]` would
/// redirect `/opt/shared/x.ts` to the shim where tsx and plain Node.js resolve
/// the named file. oxc_resolver's own gate in `resolve_path_alias` rejects
/// only `.`-prefixed specifiers, so this check cannot piggyback on it.
fn is_bare_specifier(specifier: &str) -> bool {
    // Node.js classifies the specifier through WHATWG URL parsing, which
    // trims leading/trailing C0 controls and spaces and drops ASCII
    // tab/newline — `" file:/x"` loads as a file URL. The gate must classify
    // the same spelling, or a catch-all `paths` entry steals such an import
    // from Node.js. Classification only: the raw spelling still drives
    // resolution, exactly as `file_specifier` treats it in `create_resolve`.
    let cleaned;
    let specifier = if any_byte(specifier.as_bytes(), |b| b <= b' ') {
        cleaned = specifier.replace(['\t', '\n', '\r'], "");
        cleaned.trim_start_matches(|c: char| c <= ' ').trim_end_matches(|c: char| c <= ' ')
    } else {
        specifier
    };
    if specifier.starts_with(['.', '/']) {
        return false;
    }
    // Package imports stay alias-eligible — tsconfig `paths` commonly maps
    // `#…` keys — even when one happens to contain a scheme.
    if specifier.starts_with('#') {
        return true;
    }
    #[cfg(windows)]
    if specifier.starts_with('\\') {
        return false;
    }
    // A URI scheme or drive prefix is an ASCII letter, then any of
    // letters/digits/`+`/`-`/`.`, then a colon (RFC 3986). Looking the colon
    // up first keeps a bare name — which never contains one — to a single
    // memchr-backed scan; the per-byte validation runs only when a colon
    // exists at all.
    match memchr::memchr(b':', specifier.as_bytes()) {
        None | Some(0) => true,
        Some(end) => {
            let bytes = specifier.as_bytes();
            !(bytes[0].is_ascii_alphabetic()
                && bytes[1..end]
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')))
        }
    }
}

/// The path to look a `tsconfig.json` up by, made absolute against `cwd`.
///
/// Discovery rejects relative paths outright — `find_tsconfig` bails out on
/// anything that is not absolute — so a caller that hands the transform API a
/// path like `"src/index.ts"` would silently get no compiler options at all.
/// That is exactly what the public API invites: `OxcTransformer` is constructed
/// with a working directory, and the repository's own tests call
/// `transformAsync("foo.ts", ...)`.
///
/// Only the tsconfig lookup uses this. The caller's original path still reaches
/// the parser, `SourceType` detection and the source map, so nothing else the
/// caller can observe changes.
fn tsconfig_lookup_path<'a>(cwd: &Path, path: &'a Path) -> Cow<'a, Path> {
    if path.is_absolute() { Cow::Borrowed(path) } else { Cow::Owned(cwd.join(path)) }
}

/// Whether a watch parent asked for the files Node.js does not report itself
/// (issue #450). `register.mjs` turns it on under `WATCH_REPORT_DEPENDENCIES`;
/// while it is off, recording costs one relaxed load per tsconfig read and
/// per failed resolve.
static WATCH_ENABLED: AtomicBool = AtomicBool::new(false);

/// Every path recorded so far, and the `file:` URLs of those not yet taken.
/// The native binding has one queue for every thread, so whichever thread
/// drains it first sends the URLs; they all end at the main thread, which
/// drops duplicates.
static WATCH_QUEUE: LazyLock<Mutex<(HashSet<PathBuf>, Vec<String>)>> =
    LazyLock::new(Default::default);

#[inline]
fn watching() -> bool {
    WATCH_ENABLED.load(Ordering::Relaxed)
}

/// Queue `path` for the watch parent, once per process.
fn report_watch_path(path: &Path) {
    if !watching() || !path.is_absolute() {
        return;
    }
    let mut queue = WATCH_QUEUE.lock().unwrap_or_else(PoisonError::into_inner);
    if queue.0.insert(path.to_path_buf()) {
        queue.1.push(path_to_file_url(&path.to_string_lossy()));
    }
}

/// Start recording the files watch mode restarts on that Node.js does not
/// report: every tsconfig read (`extends` chain and `references` included)
/// and the paths a failed resolve looked for. Call it before the first
/// transform or resolve: a tsconfig is read once, and one read before this is
/// never recorded.
#[cfg_attr(feature = "napi", napi)]
pub fn enable_watch_report() {
    WATCH_ENABLED.store(true, Ordering::Relaxed);
}

/// The `file:` URLs recorded since the last call, each path once per process.
/// Always empty while recording is off.
#[cfg_attr(feature = "napi", napi)]
pub fn take_watch_dependencies() -> Vec<String> {
    if !watching() {
        return Vec::new();
    }
    mem::take(&mut WATCH_QUEUE.lock().unwrap_or_else(PoisonError::into_inner).1)
}

/// The paths a failed resolve looked for that are worth watching, sorted
/// (the resolver's set is unordered) and capped. The resolver also lists a
/// `package.json` in every ancestor up to the root and the `node_modules`
/// folders it walked, which are noise; a file directly in the root is never
/// one a project creates.
fn watch_candidates<'a>(missing: impl IntoIterator<Item = &'a PathBuf>) -> Vec<&'a PathBuf> {
    // A directory import tries about 24 paths; the cap only bounds a bad alias.
    const MAX_CANDIDATES: usize = 64;
    let mut candidates: Vec<&PathBuf> = missing
        .into_iter()
        .filter(|path| path.file_name() != Some(OsStr::new("package.json")))
        .filter(|path| !path.components().any(|c| c.as_os_str() == "node_modules"))
        .filter(|path| path.parent().and_then(Path::parent).is_some())
        .collect();
    candidates.sort();
    candidates.truncate(MAX_CANDIDATES);
    candidates
}

/// The OS file system, recording every tsconfig the resolver reads for watch
/// mode.
///
/// oxc_resolver 11 reads text only for tsconfig files: `read_to_string` has
/// one caller, the tsconfig loader, while `package.json` goes through `read`.
/// So this sees the explicit config, every discovered one, each `extends`
/// target (relative, package or `#imports`) and `references`. Discovery reads
/// only files that exist, so a failed read is a file some config names, and
/// creating it must restart too. A unit test pins that; recheck it on each
/// resolver upgrade.
struct WatchFs(FileSystemOs);

impl FileSystem for WatchFs {
    #[cfg(not(feature = "yarn_pnp"))]
    fn new() -> Self {
        Self(<FileSystemOs as FileSystem>::new())
    }

    #[cfg(feature = "yarn_pnp")]
    fn new(yarn_pnp: bool) -> Self {
        Self(<FileSystemOs as FileSystem>::new(yarn_pnp))
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        FileSystem::read(&self.0, path)
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        let text = FileSystem::read_to_string(&self.0, path);
        // Belt and braces: should a later resolver read package.json as text,
        // the one in every ancestor directory must still not be reported.
        if path.file_name() != Some(OsStr::new("package.json")) {
            report_watch_path(path);
            // A missing `extends: "./base.json"` is read as `base.json.json`.
            if text.is_err()
                && let Some(named) = path.to_str().and_then(|p| p.strip_suffix(".json"))
                && named.ends_with(".json")
            {
                report_watch_path(Path::new(named));
            }
        }
        text
    }

    fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        FileSystem::metadata(&self.0, path)
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        FileSystem::symlink_metadata(&self.0, path)
    }

    fn read_link(&self, path: &Path) -> std::result::Result<PathBuf, ResolveError> {
        FileSystem::read_link(&self.0, path)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        FileSystem::canonicalize(&self.0, path)
    }
}

/// oxc_resolver's resolver on [`WatchFs`]; `clone_with_options` shares the
/// file system and cache, so every condition resolver records too.
type Resolver = ResolverGeneric<WatchFs>;

/// One JavaScript thread's loader state. Node.js workers have separate environments
/// and can select different tsconfigs, even though they share this native library.
#[derive(Default)]
struct LoaderContext {
    resolver_and_tsconfig: OnceLock<(Resolver, TsconfigSource)>,
    tsconfig_override: Mutex<TsconfigOverride>,
    transform_deps: Mutex<TransformDeps>,
    /// Each export-condition/extension-order variant shares this context's base
    /// resolver caches. Keeping them here prevents one Worker's first resolution
    /// from choosing the tsconfig for other workers.
    condition_resolvers: Mutex<Vec<ConditionResolver>>,
    /// Memoize ancestor walks per importer directory, like the resolver's own
    /// discovery cache. Invalid configs are not cached, so a corrected file is read
    /// again; a newly created config stays invisible for this context's lifetime.
    nearest_tsconfig: Mutex<HashMap<PathBuf, Option<Arc<TsConfig>>>>,
}

thread_local! {
    static LOADER_CONTEXT: RefCell<Arc<LoaderContext>> =
        RefCell::new(Arc::new(LoaderContext::default()));
    static LOADER_ENVIRONMENT: RefCell<Option<LoaderEnvironment>> = const { RefCell::new(None) };
}

fn loader_context() -> Arc<LoaderContext> {
    LOADER_CONTEXT.with(|context| Arc::clone(&context.borrow()))
}

/// Owned values from the calling JavaScript environment. A Worker's `process.env`
/// can differ from the native process environment, even when a variable is absent.
/// Keep this per invocation: configuration stays mutable until its existing deadline,
/// and an async task must retain the values from its own caller.
#[derive(Clone, Default)]
struct LoaderEnvironment {
    ts_node_project: Option<String>,
    oxc_tsconfig_path: Option<String>,
    oxc_transform_all: Option<String>,
}

impl LoaderEnvironment {
    fn read(env: &Env) -> Result<Option<Self>> {
        // Browser/WASI hosts can provide no Node.js process object. They retain
        // their native/WASI environment; a real Worker's empty env stays empty.
        let Some(process): Option<Object> = env.get_global()?.get_named_property("process")? else {
            return Ok(None);
        };
        let Some(process_env): Option<Object> = process.get_named_property("env")? else {
            return Ok(None);
        };
        Ok(Some(Self {
            ts_node_project: process_env.get_named_property("TS_NODE_PROJECT")?,
            oxc_tsconfig_path: process_env.get_named_property("OXC_TSCONFIG_PATH")?,
            oxc_transform_all: process_env.get_named_property("OXC_TRANSFORM_ALL")?,
        }))
    }

    fn var(&self, name: &str) -> Option<String> {
        match name {
            "TS_NODE_PROJECT" => self.ts_node_project.clone(),
            "OXC_TSCONFIG_PATH" => self.oxc_tsconfig_path.clone(),
            "OXC_TRANSFORM_ALL" => self.oxc_transform_all.clone(),
            _ => None,
        }
    }
}

struct LoaderEnvironmentGuard(Option<LoaderEnvironment>);

impl LoaderEnvironmentGuard {
    fn enter(environment: Option<LoaderEnvironment>) -> Self {
        Self(LOADER_ENVIRONMENT.with(|current| current.replace(environment)))
    }

    fn from_env(env: &Env) -> Result<Self> {
        Ok(Self::enter(LoaderEnvironment::read(env)?))
    }
}

impl Drop for LoaderEnvironmentGuard {
    fn drop(&mut self) {
        LOADER_ENVIRONMENT.with(|current| {
            current.replace(self.0.take());
        });
    }
}

/// Rust embedders without a JavaScript invocation retain the native environment.
fn loader_env(name: &str) -> Option<String> {
    LOADER_ENVIRONMENT.with(|current| match current.borrow().as_ref() {
        Some(environment) => environment.var(name),
        None => env::var(name).ok(),
    })
}

// The public asynchronous transformer computes on a libuv pool thread. Carry the
// caller's context into that job and restore the pool thread's prior context even
// when the transform returns an error or panics.
#[cfg(feature = "napi")]
struct LoaderContextGuard {
    previous: Arc<LoaderContext>,
    _environment: LoaderEnvironmentGuard,
}

#[cfg(feature = "napi")]
impl LoaderContextGuard {
    fn enter(context: Arc<LoaderContext>, environment: Option<LoaderEnvironment>) -> Self {
        Self {
            previous: LOADER_CONTEXT.with(|current| current.replace(context)),
            _environment: LoaderEnvironmentGuard::enter(environment),
        }
    }
}

#[cfg(feature = "napi")]
impl Drop for LoaderContextGuard {
    fn drop(&mut self) {
        LOADER_CONTEXT.with(|current| {
            current.replace(Arc::clone(&self.previous));
        });
    }
}

/// The tsconfig named through [`set_tsconfig_path`], and what [`init_resolver`]
/// made of it once it has read it.
///
/// Both live behind one lock so that a call racing the resolver's
/// initialisation either lands before it reads the path or is rejected —
/// never accepted and then silently ignored.
struct TsconfigOverride {
    path: Option<PathBuf>,
    source: &'static str,
    /// The loader passes the choice from this JavaScript thread's `process.env`.
    /// Unlike Rust's process-wide environment, that can differ in each Worker.
    use_process_env: bool,
    /// Set once [`init_resolver`] has read the override: the working directory
    /// it resolved relative paths against, and the explicit config it settled
    /// on, from this override or from the environment.
    consumed: Option<(PathBuf, Option<(PathBuf, &'static str)>)>,
}

impl Default for TsconfigOverride {
    fn default() -> Self {
        Self { path: None, source: "setTsconfigPath()", use_process_env: true, consumed: None }
    }
}

/// Pin one `tsconfig.json` for every file, as `OXC_TSCONFIG_PATH` does, but
/// without touching `process.env` — so the user's script and the processes it
/// spawns do not inherit a config chosen for the loader (issue #806).
///
/// A path set here takes precedence over `TS_NODE_PROJECT` and
/// `OXC_TSCONFIG_PATH`. A relative path is resolved against the working
/// directory the loader runs in, like the environment variables. `null`,
/// `undefined` or an empty string clears the override and goes back to the
/// environment variables, then to discovery.
///
/// The resolver and its tsconfig belong to the current loader context and are
/// created on its first transform or resolve, so this has to run before that. Calling
/// it afterwards throws, unless it names the config already in use, whether
/// that came from here or from an environment variable. Asynchronous loader
/// registration freezes the selection earlier so its hook thread uses the same config.
#[cfg_attr(feature = "napi", napi)]
pub fn set_tsconfig_path(path: Option<String>) -> Result<()> {
    set_tsconfig_override(path, true, "setTsconfigPath()")
}

/// Initialize a loader from its JavaScript environment, already resolved by its
/// wrapper. `None` selects discovery, without reading the parent process's env.
pub fn initialize_loader(path: Option<String>) -> Result<()> {
    set_tsconfig_override(path, false, "setTsconfigPath()")
}

#[cfg(feature = "napi")]
#[napi(js_name = "initializeLoader")]
/// Initialize this loader from a frozen tsconfig selection. A missing or empty path
/// selects discovery without reading environment variables. The optional source
/// preserves the original diagnostic label: `setTsconfigPath()`, `TS_NODE_PROJECT`,
/// or `OXC_TSCONFIG_PATH`.
pub fn initialize_loader_js(path: Option<String>, source: Option<String>) -> Result<()> {
    let source = match source.as_deref() {
        None | Some("setTsconfigPath()") => "setTsconfigPath()",
        Some("TS_NODE_PROJECT") => "TS_NODE_PROJECT",
        Some("OXC_TSCONFIG_PATH") => "OXC_TSCONFIG_PATH",
        _ => return Err(Error::new(Status::InvalidArg, "Invalid tsconfig source")),
    };
    set_tsconfig_override(path, false, source)
}

fn set_tsconfig_override(
    path: Option<String>,
    use_process_env: bool,
    source: &'static str,
) -> Result<()> {
    // Kept as given: a relative path is joined to the loader's working directory
    // in `init_resolver`, exactly like the environment variables. The native
    // current directory is not that directory under WASI.
    let path = path.filter(|path| !path.is_empty()).map(PathBuf::from);
    let context = loader_context();
    let mut tsconfig_override =
        context.tsconfig_override.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((cwd, active)) = &tsconfig_override.consumed {
        // Naming the config already in use is fine, wherever it came from.
        let same = match &path {
            Some(path) => {
                active.as_ref().map(|(path, _)| path.as_path())
                    == Some(&*absolute_tsconfig_path(cwd, path.clone()))
            }
            None if use_process_env => tsconfig_override.path.is_none(),
            None => active.is_none(),
        };
        if same {
            // Remember it, so `getTsconfigPath()` reports the accepted path even
            // when the environment chose it first.
            tsconfig_override.path = path;
            tsconfig_override.source = source;
            tsconfig_override.use_process_env = use_process_env;
            return Ok(());
        }
        return Err(Error::new(
            Status::GenericFailure,
            "setTsconfigPath() must be called before the first transform or resolve",
        ));
    }
    tsconfig_override.path = path;
    tsconfig_override.source = source;
    tsconfig_override.use_process_env = use_process_env;
    Ok(())
}

/// The path last passed to [`set_tsconfig_path`], exactly as given, or `null`.
///
/// A loader must pass this to its `module.register()` hook thread, whose context
/// starts without an override. This also applies to a separate WASI binding.
#[cfg_attr(feature = "napi", napi)]
pub fn get_tsconfig_path() -> Option<String> {
    let context = loader_context();
    let tsconfig_override =
        context.tsconfig_override.lock().unwrap_or_else(PoisonError::into_inner);
    tsconfig_override.path.as_ref().map(|path| path.to_string_lossy().into_owned())
}

/// The selected tsconfig and its original source, sent to an asynchronous loader.
/// `None` selects discovery explicitly, without consulting the receiving thread's env.
#[napi(object)]
pub struct FrozenTsconfig {
    pub path: Option<String>,
    pub source: Option<String>,
}

/// Freeze the selection without parsing the config or creating a resolver. Only the
/// thread that actually resolves or transforms a file should emit config diagnostics.
pub fn freeze_tsconfig(cwd: String) -> FrozenTsconfig {
    match select_tsconfig(PathBuf::from(cwd)) {
        Some((path, source)) => FrozenTsconfig {
            path: Some(path.to_string_lossy().into_owned()),
            source: Some(source.to_owned()),
        },
        None => FrozenTsconfig { path: None, source: None },
    }
}

#[cfg(feature = "napi")]
#[napi(js_name = "freezeTsconfig")]
/// Freeze this thread's effective tsconfig path and diagnostic source for an
/// asynchronous loader. An absent path means discovery. This does not parse the
/// config or emit diagnostics; it prevents later changes to the selected config.
pub fn freeze_tsconfig_js(env: Env, cwd: String) -> Result<FrozenTsconfig> {
    let _environment = LoaderEnvironmentGuard::from_env(&env)?;
    Ok(freeze_tsconfig(cwd))
}

/// Transform `node_modules` dependencies too, as `OXC_TRANSFORM_ALL` does, but
/// without touching `process.env` — so the user's script and the processes it
/// spawns do not inherit a choice made for the loader (issue #821).
///
/// `"typescript"` transforms only the TypeScript-family dependencies —
/// `.ts`, `.mts`, `.cts` and `.tsx` — and `"all"` every file, including
/// JavaScript. `"off"` keeps dependencies untouched even when the variable
/// asks for more. `null`, `undefined` or an empty string clears the override
/// and goes back to `OXC_TRANSFORM_ALL`. A mode set here takes precedence
/// over the environment variable, as [`set_tsconfig_path`] does over its
/// variables.
///
/// The mode is read once per loader context, on the first transform or resolve, so
/// this has to run before that. Calling it afterwards throws, unless it names
/// the mode already in use, whether that came from here or from the
/// environment variable. With asynchronous loader hooks the deadline is earlier:
/// registration sends a frozen mode to the `module.register()` hook thread, so
/// the mode is the one in effect when `@oxc-node/core/register` is imported.
#[cfg_attr(feature = "napi", napi)]
pub fn set_transform_deps(mode: Option<String>) -> Result<()> {
    let mode = match mode {
        // `null`/`undefined`/empty clear the override, back to the variable.
        None => None,
        Some(mode) if mode.is_empty() => None,
        Some(mode) => Some(match mode.as_str() {
            "typescript" => DepsMode::Typescript,
            "all" => DepsMode::All,
            // Explicit off: undoes the environment variable as well as an
            // earlier override.
            "off" => DepsMode::Off,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    "setTransformDeps() expects \"typescript\", \"all\" or \"off\"",
                ));
            }
        }),
    };
    let context = loader_context();
    let mut deps = context.transform_deps.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(consumed) = deps.consumed {
        // Naming the mode already in use is fine, wherever it came from;
        // anything else — `null` asking for the variable's answer included —
        // could not take effect anyway.
        if mode == Some(consumed) {
            deps.mode = mode;
            return Ok(());
        }
        if mode.is_none() && deps.mode.is_none() {
            // Clearing an override that was never set asks for exactly the
            // mode the environment already chose.
            return Ok(());
        }
        return Err(Error::new(
            Status::GenericFailure,
            "setTransformDeps() must be called before the first transform or resolve",
        ));
    }
    deps.mode = mode;
    Ok(())
}

/// The mode last passed to [`set_transform_deps`] — `"off"`, `"typescript"`
/// or `"all"` — or `null` when there is no override, including after it was
/// cleared. An explicit `"off"` round-trips: returning `null` for it would
/// send a wrapper that forwards the answer to another binding back to the
/// environment variable instead.
///
/// A loader must pass this to its `module.register()` hook thread, whose context
/// starts without an override. This also applies to a separate WASI binding.
#[cfg_attr(feature = "napi", napi)]
pub fn get_transform_deps() -> Option<String> {
    let context = loader_context();
    let deps = context.transform_deps.lock().unwrap_or_else(PoisonError::into_inner);
    deps.mode.map(|mode| {
        match mode {
            DepsMode::Off => "off",
            DepsMode::Typescript => "typescript",
            DepsMode::All => "all",
        }
        .to_owned()
    })
}

/// Whether the mode in effect transforms a `node_modules` file at `path`, for
/// the `pirates` matcher in `register.mjs`. Asking the binding keeps
/// `OXC_TRANSFORM_ALL`'s grammar and the TypeScript-family extensions in one
/// place, and — unlike a mode snapshotted at module evaluation — honours a
/// `setTransformDeps` call made after `@oxc-node/core/register` loaded.
pub fn transforms_dep(path: String) -> bool {
    deps_mode().transforms(Path::new(&path).extension().and_then(|ext| ext.to_str()))
}

#[cfg(feature = "napi")]
#[napi(js_name = "transformsDep")]
/// Whether this thread's dependency policy transforms the file at `path`.
/// Before the first transform, resolve, or asynchronous loader registration, this
/// honors `setTransformDeps` and this thread's `OXC_TRANSFORM_ALL`. After that point
/// it uses the frozen policy.
pub fn transforms_dep_js(env: Env, path: String) -> Result<bool> {
    let _environment = LoaderEnvironmentGuard::from_env(&env)?;
    Ok(transforms_dep(path))
}

/// Latch the dependency mode without a transform or resolve having run, and
/// return it — `"off"`, `"typescript"` or `"all"`. The `module.register()`
/// path hands the mode to the hook thread as a snapshot: under WASI that
/// thread's binding is a separate copy whose own `env` is a stale snapshot of
/// the host's, so the frozen mode has to travel in the registration data —
/// an `env`-only choice would diverge between the `require()` matcher on
/// this binding and the ESM hooks on the other. Freezing also makes a later
/// `setTransformDeps` throw instead of being silently ignored, and aligns
/// the deadline on every `module.register()` runtime.
pub fn freeze_transform_deps() -> String {
    let context = loader_context();
    let mut deps = context.transform_deps.lock().unwrap_or_else(PoisonError::into_inner);
    if deps.consumed.is_none() {
        deps.consumed = Some(deps.mode.unwrap_or_else(deps_mode_from_env));
    }
    // `consumed` was just latched above if it was unset.
    match deps.consumed.unwrap() {
        DepsMode::Off => "off",
        DepsMode::Typescript => "typescript",
        DepsMode::All => "all",
    }
    .to_owned()
}

#[cfg(feature = "napi")]
#[napi(js_name = "freezeTransformDeps")]
/// Freeze this thread's dependency policy and return `"off"`, `"typescript"`, or
/// `"all"`. Asynchronous loader registration sends this value to its hook thread so
/// ESM and CommonJS use the same policy. Later calls to `setTransformDeps` cannot
/// change the frozen policy.
pub fn freeze_transform_deps_js(env: Env) -> Result<String> {
    let _environment = LoaderEnvironmentGuard::from_env(&env)?;
    Ok(freeze_transform_deps())
}

/// Node.js' `--preserve-symlinks` and `--preserve-symlinks-main`.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct PreserveSymlinks {
    preserve_symlinks: bool,
    preserve_symlinks_main: bool,
}

impl PreserveSymlinks {
    /// The flags as Node.js reads them: `NODE_PRESERVE_SYMLINKS=1` first, then
    /// `NODE_OPTIONS`, then the command line (`process.execArgv`), the last
    /// mention of a flag winning. Option names take `_` for `-`, and a boolean
    /// option takes a `--no-` prefix. Node.js also accepts `=<anything>` after
    /// either form and ignores the value: `--preserve-symlinks=false` preserves.
    fn parse(env_flag: Option<&str>, node_options: Option<&str>, exec_argv: &[String]) -> Self {
        let mut flags = Self { preserve_symlinks: env_flag == Some("1"), ..Self::default() };
        let node_options = node_options.map(split_node_options).unwrap_or_default();
        for arg in
            node_options.iter().map(String::as_str).chain(exec_argv.iter().map(String::as_str))
        {
            let Some(name) = arg.strip_prefix("--") else {
                continue;
            };
            let name = name.split_once('=').map_or(name, |(name, _)| name).replace('_', "-");
            let (name, value) = match name.strip_prefix("no-") {
                Some(name) => (name, false),
                None => (name.as_str(), true),
            };
            match name {
                "preserve-symlinks" => flags.preserve_symlinks = value,
                "preserve-symlinks-main" => flags.preserve_symlinks_main = value,
                _ => {}
            }
        }
        flags
    }
}

/// `NODE_OPTIONS` split into arguments as Node.js splits it: on spaces, with
/// `"…"` quoting a value that holds them and `\` escaping inside quotes.
fn split_node_options(options: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_arg = false;
    let mut quoted = false;
    let mut chars = options.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' if quoted => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '"' => {
                quoted = !quoted;
                in_arg = true;
            }
            ' ' if !quoted => {
                if in_arg {
                    args.push(std::mem::take(&mut current));
                    in_arg = false;
                }
            }
            c => {
                current.push(c);
                in_arg = true;
            }
        }
    }
    if in_arg {
        args.push(current);
    }
    args
}

/// This thread's [`PreserveSymlinks`], read once from its `process`: the flags
/// are fixed when a Node.js environment starts, and only `process.execArgv`
/// carries the command line on every thread and on WASI alike. Each `Worker`
/// has its own environment, on its own thread, and may be started with its own
/// `execArgv`, so the answer is kept per thread rather than for the process.
fn preserve_symlinks(env: &Env) -> PreserveSymlinks {
    thread_local! {
        static FLAGS: OnceCell<PreserveSymlinks> = const { OnceCell::new() };
    }
    FLAGS.with(|flags| {
        *flags.get_or_init(|| {
            let read = || -> Result<PreserveSymlinks> {
                let process: Object = env.get_global()?.get_named_property("process")?;
                let exec_argv: Vec<String> = process.get_named_property("execArgv")?;
                let process_env: Object = process.get_named_property("env")?;
                let var = |name: &str| -> Result<Option<String>> {
                    process_env.get_named_property::<Option<String>>(name)
                };
                Ok(PreserveSymlinks::parse(
                    var("NODE_PRESERVE_SYMLINKS")?.as_deref(),
                    var("NODE_OPTIONS")?.as_deref(),
                    &exec_argv,
                ))
            };
            read().unwrap_or_default()
        })
    })
}

/// A resolver for one set of export conditions, one [`ExtensionOrder`] and
/// one answer to whether symlinks resolve to their real path.
type ConditionResolver = (Vec<String>, ExtensionOrder, bool, Arc<Resolver>);

/// Which file wins when several share a name (`dep.js` beside `dep.ts`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ExtensionOrder {
    /// JavaScript first: what a package publishes is its compiled output, and
    /// the base resolver's order. Used for importers inside `node_modules`.
    Package,
    /// TypeScript first, as tsc and tsx resolve: a project that compiles in
    /// place, or keeps generated `.js` beside its sources, must run the
    /// sources rather than stale output (issue #840).
    Source,
    /// The file the specifier names, then TypeScript, for the entry point and an
    /// importer that is not TypeScript: `./x.js` is `x.js` when it exists, as
    /// Node.js loads it, and `x.ts`, `x.tsx` or `x.jsx` when it does not (issue
    /// #878). Extensionless specifiers still try TypeScript first.
    Named,
}

fn resolver_for_conditions(
    base: &Resolver,
    conditions: &[String],
    order: ExtensionOrder,
    symlinks: bool,
) -> Arc<Resolver> {
    let context = loader_context();
    let mut resolvers = context.condition_resolvers.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((.., resolver)) = resolvers
        .iter()
        .find(|(names, o, s, _)| names == conditions && *o == order && *s == symlinks)
    {
        return Arc::clone(resolver);
    }
    let options =
        ResolveOptions { condition_names: conditions.to_vec(), symlinks, ..base.options().clone() };
    let options = match order {
        ExtensionOrder::Package => options,
        ExtensionOrder::Source => source_order(options),
        ExtensionOrder::Named => named_order(options),
    };
    let resolver = Arc::new(base.clone_with_options(options));
    resolvers.push((conditions.to_vec(), order, symlinks, Arc::clone(&resolver)));
    resolver
}

/// Extensions [`ExtensionOrder::Source`] tries ahead of where
/// [`ExtensionOrder::Package`] tries them. They are also the importer extensions
/// tsx counts as TypeScript (`/\.([cm]?ts|[tj]sx)$/`), which resolve with `Source`.
const SOURCE_FIRST_EXTENSIONS: [&str; 5] = ["ts", "tsx", "mts", "cts", "jsx"];

/// The base options with TypeScript tried before JavaScript, in the `.js`,
/// `.jsx`, `.mjs` and `.cjs` aliases and in the extensions an extensionless
/// specifier tries, and `.jsx` as a `.js` alias target the way tsc maps it.
fn source_order(options: ResolveOptions) -> ResolveOptions {
    let owned = |extensions: &[&str]| extensions.iter().map(|ext| (*ext).to_owned()).collect();
    ResolveOptions {
        extension_alias: vec![
            (".js".to_owned(), owned(&[".ts", ".tsx", ".js", ".jsx"])),
            (".jsx".to_owned(), owned(&[".tsx", ".ts", ".jsx", ".js"])),
            (".mjs".to_owned(), owned(&[".mts", ".mjs"])),
            (".cjs".to_owned(), owned(&[".cts", ".cjs"])),
        ],
        extensions: owned(&[
            ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs", ".json", ".wasm", ".node",
        ]),
        ..options
    }
}

/// [`source_order`] with the file a `.js`, `.jsx`, `.mjs` or `.cjs` specifier
/// names tried first, so `./x.js` is `x.js` when it exists (issue #878).
fn named_order(options: ResolveOptions) -> ResolveOptions {
    let owned = |extensions: &[&str]| extensions.iter().map(|ext| (*ext).to_owned()).collect();
    ResolveOptions {
        extension_alias: vec![
            (".js".to_owned(), owned(&[".js", ".ts", ".tsx", ".jsx"])),
            (".jsx".to_owned(), owned(&[".jsx", ".tsx", ".ts", ".js"])),
            (".mjs".to_owned(), owned(&[".mjs", ".mts"])),
            (".cjs".to_owned(), owned(&[".cjs", ".cts"])),
        ],
        ..source_order(options)
    }
}

/// The order a request resolves with, from what imports it. An importer inside
/// `node_modules` keeps the package order, and a TypeScript or JSX file resolves
/// TypeScript first (issue #840). The entry point (no parent), a preload (a
/// directory parent) and any other importer get the file they name (issue #878),
/// as tsx decides when `allowJs` is off.
fn extension_order(parent: Option<&Path>, parent_file: Option<&Path>) -> ExtensionOrder {
    if parent.and_then(Path::to_str).is_some_and(|path| path.contains(NODE_MODULES_PATH)) {
        ExtensionOrder::Package
    } else if parent_file
        .and_then(Path::extension)
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SOURCE_FIRST_EXTENSIONS.contains(&ext))
    {
        ExtensionOrder::Source
    } else {
        ExtensionOrder::Named
    }
}

#[cfg(not(target_os = "windows"))]
const NODE_MODULES_PATH: &str = "/node_modules/";

#[cfg(target_os = "windows")]
const NODE_MODULES_PATH: &str = "\\node_modules\\";

/// How far into `node_modules` the loader reaches. `Off` leaves dependencies
/// untouched, `Typescript` covers only the TypeScript-family extensions —
/// `.ts`, `.mts`, `.cts` and `.tsx` — and `All` everything. Chosen by
/// `OXC_TRANSFORM_ALL` or [`set_transform_deps`] (issue #821); the setter wins.
#[derive(Clone, Copy, PartialEq, Eq)]
enum DepsMode {
    Off,
    Typescript,
    All,
}

/// Extensions that are TypeScript family inside `node_modules` for
/// [`DepsMode::Typescript`]. `.js` is never among them: this mode exists to
/// run TypeScript dependencies only.
const TS_DEP_EXTENSIONS: [&str; 4] = ["ts", "mts", "cts", "tsx"];

impl DepsMode {
    /// Whether a `node_modules` file with this extension gets its source
    /// transformed. `.mts`/`.cts` qualify for `Typescript` — they are
    /// TypeScript files whatever the resolved module system.
    fn transforms(self, extension: Option<&str>) -> bool {
        match self {
            Self::Off => false,
            Self::All => true,
            Self::Typescript => {
                extension.is_some_and(|extension| TS_DEP_EXTENSIONS.contains(&extension))
            }
        }
    }

    /// Whether the resolve hook answers the format for a `node_modules` file
    /// with this extension rather than keeping the `null` that defers the
    /// load to Node.js' own lookup. Files Node.js could never run —
    /// TypeScript, the extra source extensions, extensionless — need ours,
    /// or they die with `ERR_UNKNOWN_FILE_EXTENSION` /
    /// `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` before `load` can
    /// transform them. Formats Node.js runs on its own stay deferred.
    fn resolves_format(self, extension: Option<&str>) -> bool {
        match extension {
            None => self == Self::All,
            Some(extension) if TS_DEP_EXTENSIONS.contains(&extension) => self != Self::Off,
            Some("jsx" | "es" | "es6") => self == Self::All,
            Some(_) => false,
        }
    }
}

/// The `OXC_TRANSFORM_ALL` value parsed as a [`DepsMode`]: absent, empty,
/// `"0"`, or `"false"` mean `Off` — matching Node.js-style flag semantics
/// where setting it to a false value must not enable it — `"typescript"`
/// selects only the TypeScript dependencies, and any other value is `All`,
/// which every previous truthy value already meant.
fn deps_mode_from_env() -> DepsMode {
    match loader_env("OXC_TRANSFORM_ALL") {
        None => DepsMode::Off,
        Some(value) => match value.as_str() {
            "" | "0" | "false" => DepsMode::Off,
            "typescript" => DepsMode::Typescript,
            _ => DepsMode::All,
        },
    }
}

/// The mode named through [`set_transform_deps`], and what [`init_resolver`]
/// made of it once it has read it.
///
/// Both live behind one lock so that a call racing the resolver's
/// initialisation either lands before it reads the mode or is rejected —
/// never accepted and then silently ignored.
#[derive(Default)]
struct TransformDeps {
    mode: Option<DepsMode>,
    /// The mode in effect once [`init_resolver`] has run: the override, or
    /// the environment's answer when there is none.
    consumed: Option<DepsMode>,
}

/// Which dependencies get transformed: [`set_transform_deps`]'s choice, or
/// `OXC_TRANSFORM_ALL`'s.
fn deps_mode() -> DepsMode {
    let context = loader_context();
    let deps = context.transform_deps.lock().unwrap_or_else(PoisonError::into_inner);
    deps.mode.or(deps.consumed).unwrap_or_else(deps_mode_from_env)
}

/// The `file:` URL scheme prefix; on POSIX the absolute path follows it
/// directly.
#[cfg(not(windows))]
const PATH_PREFIX: &str = "file://";

/// Convert a `file://` URL into a filesystem path, including the UNC
/// authority form: `\\server\share\dir\module.ts` round trips as
/// `file://server/share/dir/module.ts`, the form `pathToFileURL` produces, so
/// the component between `file://` and the next `/` is the server name rather
/// than a path segment. Reading it as one lost the host on the way in and
/// wrote `file://///server/…` on the way out (issue #744).
#[cfg(windows)]
fn file_url_to_path(url: &str) -> Option<PathBuf> {
    windows_file_url::url_to_path(url)
}

/// Windows `file:` URL rules (issue #744); see windows_file_url.rs.
#[cfg(any(windows, test))]
mod windows_file_url;

/// Convert a `file://` URL into a filesystem path.
///
/// Node hands the loader hooks URLs, and a URL percent-encodes every character
/// outside the unreserved set: a space arrives as `%20`, `õ` as `%C3%B5`.
/// Slicing the scheme off without decoding leaves a string that still looks
/// like a path but names a directory nobody has — so tsconfig discovery walks
/// past the project and finds nothing, and relative specifiers resolve against
/// a directory that does not exist.
///
/// The `?query` and `#fragment` are not part of the path and are dropped
/// before decoding, the way `fileURLToPath` reads only the pathname: an
/// encoded `%23` or `%3F` is a file-name character, a raw `#` or `?` is not.
///
/// Returns `None` if `url` is not a `file://` URL, or if its escapes do not
/// decode to valid UTF-8.
#[cfg(not(windows))]
fn file_url_to_path(url: &str) -> Option<PathBuf> {
    let path = url_path(url.strip_prefix(PATH_PREFIX)?);
    // The URL parser reads a raw `\` as `/`, as it does in every special URL.
    let path = if memchr::memchr(b'\\', path.as_bytes()).is_some() {
        Cow::Owned(path.replace('\\', "/"))
    } else {
        Cow::Borrowed(path)
    };
    decode_url_path(&path).map(|path| PathBuf::from(path.into_owned()))
}

/// Percent-decode a URL pathname, validating the decoded bytes as UTF-8.
/// Returns `None` if the escapes do not decode to valid UTF-8.
fn decode_url_path(path: &str) -> Option<Cow<'_, str>> {
    let bytes = path.as_bytes();

    // Two vectorised passes carry this function, and the byte loop only ever
    // runs over the escaped tail.
    //
    // `memchr` compares a vector register at a time, dispatching to SSE2 or
    // AVX2 on x86 and NEON on aarch64 at runtime. Most URLs hold no escape at
    // all, and for those this single scan is the whole function: no allocation,
    // no copy, no decode loop.
    let Some(mut index) = memchr::memchr(b'%', bytes) else {
        return Some(Cow::Borrowed(path));
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

    // Do not be tempted to `memchr` again per gap and bulk-copy between
    // escapes. Escaped paths have short gaps — one non-ASCII character is three
    // consecutive escapes — and a `memchr` call per gap costs more than the
    // bytes it saves. Measured on a percent-encoded CJK path it was 90% slower
    // than the loop above.
    //
    // The decoded bytes are arbitrary, so they still need validating. This is
    // the second vectorised pass, and it is where escape-heavy paths win most.
    simdutf8::basic::from_utf8(&decoded).ok().map(|text| Cow::Owned(text.to_owned()))
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Whether a URL pathname holds an encoded path separator (`%2F` or `%5C`,
/// either case). Node refuses such a specifier with
/// `ERR_INVALID_MODULE_SPECIFIER` rather than decoding it into a separator
/// and loading a file from a subdirectory, so oxc-node leaves it to Node.
fn has_encoded_separator(pathname: &str) -> bool {
    let bytes = pathname.as_bytes();
    memchr::memchr_iter(b'%', bytes).any(|index| {
        bytes.get(index + 1..index + 3).is_some_and(|hex| {
            hex[0] == b'2' && hex[1].eq_ignore_ascii_case(&b'f')
                || hex[0] == b'5' && hex[1].eq_ignore_ascii_case(&b'c')
        })
    })
}

/// Whether a URL pathname holds a `%` that is not followed by two hex digits
/// (`%zz`, a trailing `%`). Node's `fileURLToPath` throws `URIError: URI
/// malformed` for it; resolving the spelling verbatim would load a file
/// literally named `a%zz.ts` instead, so oxc-node leaves it to Node.
fn has_malformed_escape(pathname: &str) -> bool {
    let bytes = pathname.as_bytes();
    memchr::memchr_iter(b'%', bytes).any(|index| {
        !bytes.get(index + 1..index + 3).is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit))
    })
}

/// The resolver request — the directory to resolve from and the specifier —
/// for the decoded pathname `path` of a URL reference, taken relative to
/// `base`. Returns `None` when the resolver cannot be asked for the file
/// exactly and Node's own resolution has to answer.
///
/// The resolver parses its specifier for a query and fragment. A decoded `#`
/// would be parsed as a fragment and a same-named prefix file would win (`a`
/// over `a#b.ts`), so it is escaped with the resolver's enhanced-resolve
/// escape (`\0#`) and stays a file-name character. A URL's own `?query` /
/// `#fragment` never reaches the resolver: with a fragment and no query it
/// tries the two as one path first, and would load `a#b.ts` for `./a#b.ts`
/// (issue #856). The caller appends it to the resolved URL instead.
///
/// Two characters cannot go through the specifier as they are: a `?` (only
/// legal in POSIX file names), for which the resolver has no escape, and a
/// `#` in a path that is not ASCII, because oxc_resolver removes the escape
/// byte by byte and mangles every multi-byte character (`õ` turns into
/// `Ãµ`). The directory the resolver starts from is a path and is never
/// parsed, so such a path is resolved as its file name from its directory;
/// only a file name that holds one of those itself is left to Node.
fn resolver_request<'a>(base: &'a Path, path: &str) -> Option<(Cow<'a, Path>, Cow<'static, str>)> {
    fn exact(path: &str) -> bool {
        let bytes = path.as_bytes();
        memchr::memchr(b'?', bytes).is_none()
            && (path.is_ascii() || memchr::memchr(b'#', bytes).is_none())
    }
    fn escaped(path: &str) -> String {
        path.replace('#', "\u{0}#")
    }
    if exact(path) {
        return Some((Cow::Borrowed(base), Cow::Owned(escaped(path))));
    }
    // Normalized lexically, as the URL parser resolves `.` and `..`.
    let mut full = PathBuf::new();
    for component in base.join(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                full.pop();
            }
            component => full.push(component),
        }
    }
    let name = full.file_name()?.to_str()?;
    if !exact(name) {
        return None;
    }
    let specifier = escaped(&format!("./{name}"));
    Some((Cow::Owned(full.parent()?.to_path_buf()), Cow::Owned(specifier)))
}

/// Whether any byte matches `pred`, 16 bytes at a time with no early exit
/// inside a chunk, so LLVM turns `pred` into vector compares (NEON, SSE2) —
/// `Iterator::any` stops after every byte and stays scalar. Measured on
/// typical paths and specifiers (aarch64): 3x–12x faster. `pred` must be plain
/// compares joined by `|`: a `matches!` with many arms becomes a bit test per
/// byte, which does not vectorize and runs slower than `any`.
#[inline]
fn any_byte(bytes: &[u8], pred: impl Fn(u8) -> bool + Copy) -> bool {
    let (chunks, rest) = bytes.as_chunks::<16>();
    chunks.iter().any(|chunk| chunk.iter().fold(false, |acc, &byte| acc | pred(byte)))
        || rest.iter().any(|&byte| pred(byte))
}

/// The bytes `encode_file_url_path` escapes: C0 controls, space, `"` `#` `%`
/// `<` `>` `?` `[` `\` `]` `^` `` ` `` `{` `|` `}` `~`, DEL and every
/// non-ASCII byte. Written as ranges and compares for `any_byte`.
#[inline(always)]
fn file_url_encoded(byte: u8) -> bool {
    (byte <= 0x20) // C0 controls and space
        | (byte >= b'{') // `{` `|` `}` `~`, DEL, non-ASCII
        | (byte.wrapping_sub(b'"') <= 1) // `"` `#`
        | (byte == b'%')
        | (byte == b'<')
        | (byte.wrapping_sub(b'>') <= 1) // `>` `?`
        | (byte.wrapping_sub(b'[') <= 3) // `[` `\` `]` `^`
        | (byte == b'`')
}

/// Percent-encode a filesystem path for the path of a `file:` URL, with the
/// encode set `pathToFileURL` uses: C0 controls, space, `"` `#` `%` `<` `>`
/// `?` `[` `\` `]` `^` `` ` `` `{` `|` `}` `~`, DEL and every non-ASCII byte
/// become `%XX` with uppercase hex; everything else, `/` and `:` included,
/// stays literal (issue #837). Left raw, a `#` or `?` in a file name starts
/// the URL's fragment or query and a `%` reads as an escape, so Node loads a
/// different file. Matching Node exactly, rather than merely encoding enough,
/// keeps the URL identical to the one Node computes for the same file —
/// under `--preserve-symlinks` that URL is the module cache key.
fn encode_file_url_path(path: &str) -> Cow<'_, str> {
    if !any_byte(path.as_bytes(), file_url_encoded) {
        return Cow::Borrowed(path);
    }
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut url = String::with_capacity(path.len() + 16);
    for byte in path.bytes() {
        if file_url_encoded(byte) {
            url.push('%');
            url.push(HEX[usize::from(byte >> 4)] as char);
            url.push(HEX[usize::from(byte & 0xf)] as char);
        } else {
            url.push(byte as char);
        }
    }
    Cow::Owned(url)
}

// Idempotent (`init` uses `try_init`), so it doubles as the embedder hook
// when `napi` is off: a host forwards it or calls it directly to honor
// `OXC_LOG` — nothing else installs the subscriber on that build.
#[cfg_attr(feature = "napi", napi)]
pub fn init_tracing() {
    init();
}

// `module_init` only exists with `napi` on (and not on wasm, where
// `init_tracing` is the entry point); the fn stays compiled under
// `default-features = false` for the `init_tracing` call above.
#[cfg_attr(all(feature = "napi", not(target_family = "wasm")), napi_derive::module_init)]
fn init() {
    use tracing_subscriber::filter::Targets;
    use tracing_subscriber::prelude::__tracing_subscriber_SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    // Only install a subscriber when `OXC_LOG` is set, and never replace one that is
    // already installed: this crate can be linked into another Node-API addon (e.g. Vite+)
    // that sets up its own global subscriber.
    // <https://github.com/oxc-project/oxc-node/issues/805>
    let Ok(env_var) = std::env::var("OXC_LOG") else {
        return;
    };
    let Ok(targets) = <Targets as std::str::FromStr>::from_str(&env_var) else {
        return;
    };

    // Usage without the `regex` feature.
    // <https://github.com/tokio-rs/tracing/issues/1436#issuecomment-918528013>
    let _ = tracing_subscriber::registry()
        .with(targets)
        // stderr, as Node.js' own diagnostics go: on stdout the log interleaved with
        // the program's output and broke whatever read it (issue #845).
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .try_init();
}

/// Whether the running Node.js executes `using` / `await using` declarations natively,
/// which every release from 24 on does. Set once `detect_runtime_syntax` runs — on the
/// addon via its `napi(module_exports)` hook; until then (and in `cargo test`, which
/// never loads it) `using` keeps being lowered, which runs everywhere.
static NATIVE_EXPLICIT_RESOURCE_MANAGEMENT: AtomicBool = AtomicBool::new(false);

/// The first Node.js major that runs explicit resource management natively.
const NATIVE_EXPLICIT_RESOURCE_MANAGEMENT_SINCE: u32 = 24;

/// With `napi` off nothing invokes this: an embedder that wants native
/// `using` support must call it from its own `napi(module_exports)` hook,
/// or `NATIVE_EXPLICIT_RESOURCE_MANAGEMENT` stays `false` and `using` is
/// lowered even on Node.js >= 24.
#[cfg_attr(feature = "napi", napi(module_exports))]
pub fn detect_runtime_syntax(_exports: Object, env: Env) -> Result<()> {
    // An unknown version (an older runtime, or a WASI host without the call) leaves the
    // flag off and `using` lowered.
    if let Ok(version) = env.get_node_version() {
        NATIVE_EXPLICIT_RESOURCE_MANAGEMENT
            .store(version.major >= NATIVE_EXPLICIT_RESOURCE_MANAGEMENT_SINCE, Ordering::Relaxed);
    }
    Ok(())
}

// `Output` is not `#[napi]`-registered when the feature is off, so it loses its
// `ToNapiValue`/`TypeName` impls and the async-task surface below — `TransformTask`,
// `impl Task` and the `transform_async` functions — is gated on `feature = "napi"`
// entirely. An embedder forwards the synchronous `transform` and wraps it in its
// own `Task` if it needs a promise; the `Output` itself cannot cross its napi
// boundary, so a forwarder maps `source()`/`source_map()` onto its own
// `#[napi(object)]` result type.
#[cfg_attr(feature = "napi", napi)]
pub struct Output {
    code: String,
    map: Option<SourceMap<'static>>,
}

#[cfg_attr(feature = "napi", napi)]
impl Output {
    #[cfg_attr(feature = "napi", napi)]
    /// Returns the generated code
    /// Cache the result of this function if you need to use it multiple times
    pub fn source(&self) -> String {
        self.code.clone()
    }

    #[cfg_attr(feature = "napi", napi)]
    /// Returns the source map as a JSON string
    /// Cache the result of this function if you need to use it multiple times
    pub fn source_map(&self) -> Option<String> {
        self.map.as_ref().map(|source_map| source_map.to_json_string())
    }
}

pub fn transform(path: String, source: Either<String, &[u8]>) -> Result<Output> {
    let transformer = OxcTransformer::new(None, None);
    transformer.transform(path, source)
}

#[cfg(feature = "napi")]
#[napi(js_name = "transform")]
pub fn transform_js(env: Env, path: String, source: Either<String, &[u8]>) -> Result<Output> {
    let _environment = LoaderEnvironmentGuard::from_env(&env)?;
    transform(path, source)
}

/// The code `transformModuleRunner` hands to `@oxc-node/core/importer`.
#[napi(object)]
pub struct ModuleRunnerOutput {
    pub code: String,
    /// The source map as a JSON string
    pub map: Option<String>,
    /// The file is an ES module. Its imports, exports and `import.meta` are calls into
    /// the runner (`__vite_ssr_import__` and friends); a CommonJS file keeps `require`,
    /// `module` and `exports`, and only its `import()` calls into the runner.
    pub esm: bool,
    /// The ES module awaits at its top level, so `require()` of it is
    /// `ERR_REQUIRE_ASYNC_MODULE`.
    pub top_level_await: bool,
}

/// The transform `@oxc-node/core/importer` runs files with: the one the load hook
/// applies, with the same tsconfig discovery, followed by oxc's module runner transform,
/// which turns `import`/`export` into calls the importer evaluates itself.
///
/// A file is an ES module as Node.js decides it: by a `.mts`/`.mjs` extension or a
/// `"type": "module"` package, else by its syntax (`import`, `export`, `import.meta` or
/// top-level await). tsconfig's `module` does not make a file without module syntax an
/// ES module here, as the resolver's format does, so `module.exports = ...` keeps
/// working in a package without `"type"`.
///
/// `sync` emits static imports without `await`, for `require()` of an ES module without
/// top-level await. Each line of the output starts on the line of the source it came
/// from.
pub fn transform_module_runner(
    path: String,
    source: Either<String, &[u8]>,
    sync: Option<bool>,
) -> Result<ModuleRunnerOutput> {
    let cwd = env::current_dir()?;
    let src_path = Path::new(&path);
    let lookup_path = tsconfig_lookup_path(&cwd, src_path).into_owned();
    let context = loader_context();
    let (resolver, tsconfig_source) =
        context.resolver_and_tsconfig.get_or_init(|| init_resolver(cwd));
    let resolved_tsconfig = tsconfig_source.for_path(resolver, &lookup_path);
    let is_es_module = is_module_file(src_path);
    let mut runner = ModuleRunner { sync: sync.unwrap_or(false), ..Default::default() };
    // The load hook's arguments: a file reported as CommonJS flips to an ES module when
    // its syntax says so.
    let (output, _) = oxc_transform(
        src_path,
        &source,
        resolved_tsconfig.as_ref().map(|t| &t.compiler_options),
        Some(Module::Preserve),
        !is_es_module,
        is_es_module,
        None,
        Some(&mut runner),
    )?;
    Ok(ModuleRunnerOutput {
        code: output.code,
        map: output.map.as_ref().map(SourceMap::to_json_string),
        esm: runner.esm,
        top_level_await: runner.top_level_await,
    })
}

#[cfg(feature = "napi")]
#[napi(js_name = "transformModuleRunner")]
/// Transform a file for `@oxc-node/core/importer`, using this thread's tsconfig.
/// ES module imports, exports, and `import.meta` become calls the importer evaluates.
/// CommonJS files retain `require`, `module`, and `exports`. With `sync: true`, static
/// imports do not use `await`; the result still identifies top-level await. Generated
/// lines retain their source line positions.
pub fn transform_module_runner_js(
    env: Env,
    path: String,
    source: Either<String, &[u8]>,
    sync: Option<bool>,
) -> Result<ModuleRunnerOutput> {
    let _environment = LoaderEnvironmentGuard::from_env(&env)?;
    transform_module_runner(path, source, sync)
}

#[cfg(feature = "napi")]
pub fn transform_async(
    path: String,
    source: Either3<String, Uint8Array, Buffer>,
) -> AsyncTask<TransformTask> {
    let transformer = OxcTransformer::new(None, None);
    transformer.transform_async(path, source)
}

#[cfg(feature = "napi")]
#[napi(js_name = "transformAsync")]
pub fn transform_async_js(
    env: Env,
    path: String,
    source: Either3<String, Uint8Array, Buffer>,
) -> Result<AsyncTask<TransformTask>> {
    let _environment = LoaderEnvironmentGuard::from_env(&env)?;
    Ok(transform_async(path, source))
}

#[cfg(feature = "napi")]
pub struct TransformTask {
    context: Arc<LoaderContext>,
    environment: Option<LoaderEnvironment>,
    cwd: String,
    helper_module_name: Option<String>,
    path: String,
    source: Either3<String, Uint8Array, Buffer>,
}

#[cfg(feature = "napi")]
#[napi]
impl Task for TransformTask {
    type Output = Output;
    type JsValue = Output;

    fn compute(&mut self) -> Result<Self::Output> {
        let _context =
            LoaderContextGuard::enter(Arc::clone(&self.context), self.environment.clone());
        let src_path = Path::new(&self.path);
        let cwd = PathBuf::from(&self.cwd);
        // Worked out before `cwd` is moved into the initialiser.
        let lookup_path = tsconfig_lookup_path(&cwd, src_path).into_owned();
        let context = loader_context();
        let (resolver, tsconfig_source) =
            context.resolver_and_tsconfig.get_or_init(|| init_resolver(cwd));
        let resolved_tsconfig = tsconfig_source.for_path(resolver, &lookup_path);
        oxc_transform(
            src_path,
            &self.source,
            resolved_tsconfig.as_ref().map(|t| &t.compiler_options),
            Some(Module::CommonJS),
            true,
            // The `pirates` hook and this public API both target CommonJS, so keep letting
            // the extension and the source decide.
            false,
            self.helper_module_name.as_deref(),
            None,
        )
        .map(|(output, _)| output)
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }

    fn finally(mut self, _: Env) -> Result<()> {
        mem::drop(mem::replace(&mut self.source, Either3::A(String::new())));
        Ok(())
    }
}

#[cfg_attr(feature = "napi", napi)]
pub struct OxcTransformer {
    cwd: String,
    /// The module name emitted for helper imports — the loaders pass a copy-tagged one
    /// (`@oxc-node/core@<tag>`) so the resolver hands each copy's helpers back to it;
    /// `None` keeps the bare `@oxc-node/core` specifier the public API has always emitted.
    helper_module_name: Option<String>,
}

impl OxcTransformer {
    pub fn new(cwd: Option<String>, helper_module_name: Option<String>) -> Self {
        Self {
            cwd: match cwd {
                Some(cwd) => cwd,
                None => env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap(),
            },
            helper_module_name,
        }
    }

    pub fn transform(&self, path: String, source: Either<String, &[u8]>) -> Result<Output> {
        let cwd = PathBuf::from(&self.cwd);
        let src_path = Path::new(&path);
        // Worked out before `cwd` is moved into the initialiser.
        let lookup_path = tsconfig_lookup_path(&cwd, src_path).into_owned();
        let context = loader_context();
        let (resolver, tsconfig_source) =
            context.resolver_and_tsconfig.get_or_init(|| init_resolver(cwd));
        let resolved_tsconfig = tsconfig_source.for_path(resolver, &lookup_path);
        oxc_transform(
            src_path,
            &source,
            resolved_tsconfig.as_ref().map(|t| &t.compiler_options),
            Some(Module::CommonJS),
            true,
            false,
            self.helper_module_name.as_deref(),
            None,
        )
        .map(|(output, _)| output)
    }

    #[cfg(feature = "napi")]
    pub fn transform_async(
        &self,
        path: String,
        source: Either3<String, Uint8Array, Buffer>,
    ) -> AsyncTask<TransformTask> {
        // Freeze selection before queuing work. A later synchronous transform must
        // not choose another config while this task waits for a libuv pool thread.
        // Parsing and diagnostics still belong to the task's compute phase.
        let _ = select_tsconfig(PathBuf::from(&self.cwd));
        let _ = freeze_transform_deps();
        AsyncTask::new(TransformTask {
            context: loader_context(),
            environment: LOADER_ENVIRONMENT.with(|environment| environment.borrow().clone()),
            path,
            source,
            cwd: self.cwd.clone(),
            helper_module_name: self.helper_module_name.clone(),
        })
    }
}

#[cfg(feature = "napi")]
#[napi]
impl OxcTransformer {
    #[napi(constructor)]
    pub fn new_js(cwd: Option<String>, helper_module_name: Option<String>) -> Self {
        Self::new(cwd, helper_module_name)
    }

    #[napi(js_name = "transform")]
    pub fn transform_js(
        &self,
        env: Env,
        path: String,
        source: Either<String, &[u8]>,
    ) -> Result<Output> {
        let _environment = LoaderEnvironmentGuard::from_env(&env)?;
        self.transform(path, source)
    }

    #[napi(js_name = "transformAsync")]
    pub fn transform_async_js(
        &self,
        env: Env,
        path: String,
        source: Either3<String, Uint8Array, Buffer>,
    ) -> Result<AsyncTask<TransformTask>> {
        let _environment = LoaderEnvironmentGuard::from_env(&env)?;
        Ok(self.transform_async(path, source))
    }
}

/// Whether class fields use `[[Define]]` semantics, i.e. TypeScript's
/// [`useDefineForClassFields`].
///
/// TypeScript defaults it to `true` when `target` is `ES2022` or later — the first target
/// with native class fields. When no `target` is set at all, TypeScript 6 and later default
/// the target to the stable ECMAScript version preceding `ESNext`, so the option defaults to
/// `true` as well (and `target: es5` was removed in TypeScript 7).
///
/// [`useDefineForClassFields`]: https://www.typescriptlang.org/tsconfig/#useDefineForClassFields
fn use_define_for_class_fields(compiler_options: Option<&CompilerOptions>) -> bool {
    if let Some(explicit) = compiler_options.and_then(|options| options.use_define_for_class_fields)
    {
        return explicit;
    }
    compiler_options
        .and_then(|options| options.target.as_deref())
        .is_none_or(target_has_native_class_fields)
}

/// Maps a tsconfig `compilerOptions.jsx` value to the [`JsxRuntime`] plus the
/// `development` flag. The values are `tsc`'s — `react`, `react-jsx`, `react-jsxdev`,
/// `preserve` and `react-native` — matched case-insensitively because `tsc` accepts any
/// casing of enum options and `oxc_resolver` hands us the verbatim string.
/// `react-jsxdev` is the automatic runtime in development mode, which emits `jsxDEV` from
/// `{jsxImportSource}/jsx-dev-runtime` and enables the `__self`/`__source` plugins.
/// `preserve` and `react-native` have no runnable equivalent under Node.js — this pipeline
/// cannot leave JSX untranspiled — so like any unknown value they fall back to the
/// automatic runtime. The Babel spellings `automatic`/`classic` stay accepted for anyone
/// passing them directly.
fn jsx_runtime(jsx: &str) -> (JsxRuntime, bool) {
    match jsx.to_ascii_lowercase().as_str() {
        "react" | "classic" => (JsxRuntime::Classic, false),
        "react-jsxdev" => (JsxRuntime::Automatic, true),
        _ => (JsxRuntime::Automatic, false),
    }
}

/// Whether a TypeScript `target` is `ES2022` or later, `ESNext` included.
fn target_has_native_class_fields(target: &str) -> bool {
    if target.eq_ignore_ascii_case("esnext") {
        return true;
    }
    // `es3`, `es5` and `es6` parse to 3, 5 and 6, all below the cutoff.
    target
        .get(..2)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("es"))
        .then(|| target[2..].parse::<u32>().ok())
        .flatten()
        .is_some_and(|year| year >= 2022)
}

/// Whether the file is an ES module whose output keeps ECMAScript module syntax — an
/// `import`/`export` declaration, `import.meta`, or top-level await. Node.js's own syntax
/// detection counts top-level await as module syntax, and oxc resolves it to a module.
///
/// The parser's module record is not enough on its own: TypeScript's CommonJS constructs
/// (`import =`, `export =`) report a module too, but they compile to `require` /
/// `module.exports`, which only run when the file stays CommonJS.
fn parsed_as_esm(program: &Program<'_>, module_record: &ModuleRecord<'_>) -> bool {
    let ts_cjs_construct = program.body.iter().any(|statement| {
        matches!(
            statement,
            Statement::TSExportAssignment(_) | Statement::TSImportEqualsDeclaration(_)
        )
    });
    has_esm_syntax(program, module_record) || (program.source_type.is_module() && !ts_cjs_construct)
}

/// Whether the file carries ECMAScript module syntax — an `import`/`export` declaration
/// or `import.meta`.
fn has_esm_syntax(program: &Program<'_>, module_record: &ModuleRecord<'_>) -> bool {
    !module_record.import_metas.is_empty() || has_module_declaration(program)
}

/// Whether the program has an `import`/`export` declaration.
fn has_module_declaration(program: &Program<'_>) -> bool {
    program.body.iter().any(has_module_declaration_statement)
}

fn has_module_declaration_statement(statement: &Statement<'_>) -> bool {
    matches!(
        statement,
        Statement::ImportDeclaration(_)
            | Statement::ExportAllDeclaration(_)
            | Statement::ExportDefaultDeclaration(_)
            | Statement::ExportDeclaration(_)
            | Statement::ExportNamedDeclaration(_)
            | Statement::ExportFromDeclaration(_)
    )
}

/// Whether a `.cts` file has an `import`/`export` declaration that needs compiling to
/// CommonJS. An empty `export {}` exports nothing and is not one: the TypeScript transform
/// appends it whenever it erases a file's last `import`/`export`, to keep the file a
/// module.
fn has_cts_module_declaration(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| match statement {
        Statement::ExportNamedDeclaration(decl) => !decl.specifiers.is_empty(),
        _ => has_module_declaration_statement(statement),
    })
}

/// The source type of a file, or `None` for a file Node.js cannot classify. An
/// extensionless file is JavaScript whose module kind its syntax decides, as
/// Node.js decides it for such a file in a package without "type".
fn source_type_from_path(path: &Path) -> Option<SourceType> {
    match SourceType::from_path(path) {
        Ok(source_type) => Some(source_type),
        Err(_) if path.extension().is_none() => Some(SourceType::unambiguous()),
        Err(_) => None,
    }
}

/// Whether the source type is a `.cts` file, CommonJS TypeScript.
fn is_cts(source_type: SourceType) -> bool {
    source_type.is_typescript() && source_type.is_commonjs()
}

/// Whether a `.cts` file that failed to parse uses `import.meta`, which the CommonJS
/// parse rejects as a syntax error: it parses cleanly as a module and has one.
fn cts_uses_import_meta(source: &str, source_type: SourceType) -> bool {
    let allocator = Allocator::default();
    let ParserReturn { diagnostics, module_record, .. } =
        Parser::new(&allocator, source, source_type.with_module(true)).parse();
    diagnostics.is_empty() && !module_record.import_metas.is_empty()
}

/// The error for a `.cts` file that uses ECMAScript module syntax.
///
/// tsc (`module: nodenext`) and tsx compile a `.cts` file's `import`/`export` to
/// CommonJS, but oxc has no ESM-to-CommonJS module transform: the module transform only
/// rewrites TypeScript's `import =` / `export =`. The declarations would reach Node.js
/// intact inside a CommonJS file, which fails differently on every load path —
/// `ERR_REQUIRE_CYCLE_MODULE` as an entry point, no named exports when imported, and
/// `require is not defined in ES module scope` from the injected helpers when
/// `require()`d (#811). Every path reports this one error instead, as Node.js' own type
/// stripping rejects such a file outright. Type-only imports and exports are erased by
/// the transform first, so only syntax that would need compiling is reported.
fn cts_module_syntax_error(path: &Path) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Failed to transform {}: a `.cts` file is CommonJS, but this one uses ES module \
             syntax (`import`, `export` or `import.meta`), which oxc-node does not compile to \
             CommonJS. Rename it to `.mts` to run it as an ES module, or write it as \
             CommonJS with `import x = require(\"...\")` and `export =`.",
            path.display()
        ),
    )
}

/// The first line of Node.js' `ERR_REQUIRE_ASYNC_MODULE` message, which the `pirates`
/// hook in `register.mjs` recognises to give the error Node.js' code.
const REQUIRE_ASYNC_MODULE_MESSAGE: &str = "require() cannot be used on an ESM graph with \
                                            top-level await. Use import() instead.";

/// The error `require()` of an ES module with top-level await raises, worded as
/// Node.js words it.
fn require_async_module_error(path: &Path) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("{REQUIRE_ASYNC_MODULE_MESSAGE}\n  Requiring {}", path.display()),
    )
}

/// Whether Node.js runs the file as CommonJS whatever its syntax: a `.cts`/`.cjs`
/// extension, or an ambiguous one inside a `"type": "commonjs"` package. Without a
/// `type`, Node.js' syntax detection runs a file with top-level await as an ES module.
fn is_commonjs_file(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("cts") || ext.eq_ignore_ascii_case("cjs") => true,
        Some(ext) if ext.eq_ignore_ascii_case("mts") || ext.eq_ignore_ascii_case("mjs") => false,
        _ => matches!(package_type(path), Some(PackageType::CommonJs)),
    }
}

/// Whether Node.js runs the file as an ES module whatever its syntax: a `.mts`/`.mjs`
/// extension, or an ambiguous one inside a `"type": "module"` package.
fn is_module_file(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("mts") || ext.eq_ignore_ascii_case("mjs") => true,
        Some(ext) if ext.eq_ignore_ascii_case("cts") || ext.eq_ignore_ascii_case("cjs") => false,
        _ => matches!(package_type(path), Some(PackageType::Module)),
    }
}

/// The `type` of the nearest `package.json`, once the resolver is set up.
fn package_type(path: &Path) -> Option<PackageType> {
    let context = loader_context();
    let (Some((resolver, _)), Some(directory), Some(name)) = (
        context.resolver_and_tsconfig.get(),
        path.parent(),
        path.file_name().and_then(|name| name.to_str()),
    ) else {
        return None;
    };
    resolver_request(directory, &format!("./{name}"))
        .and_then(|(directory, specifier)| resolver.resolve(&directory, &specifier).ok())
        .and_then(|resolution| resolution.package_json().and_then(|json| json.r#type()))
}

/// Whether `program` awaits at its top level: an `await`, a `for await` or an
/// `await using` outside every function.
fn has_top_level_await(program: &Program<'_>) -> bool {
    struct TopLevelAwaitFinder(bool);

    impl<'a> Visit<'a> for TopLevelAwaitFinder {
        fn visit_await_expression(&mut self, _it: &AwaitExpression<'a>) {
            self.0 = true;
        }

        fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
            self.0 |= it.r#await;
            walk::walk_for_of_statement(self, it);
        }

        fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
            self.0 |= it.kind.is_await();
            walk::walk_variable_declaration(self, it);
        }

        fn visit_function(&mut self, _it: &oxc::ast::ast::Function<'a>, _flags: ScopeFlags) {}

        fn visit_arrow_function_expression(&mut self, _it: &ArrowFunctionExpression<'a>) {}
    }

    let mut finder = TopLevelAwaitFinder(false);
    finder.visit_program(program);
    finder.0
}

/// A parsed source, plus whether it became valid only when parsed as a module — a
/// top-level `for await` without any `import`/`export`/`import.meta`, which oxc cannot
/// resolve to a module on its own.
struct Parsed<'a> {
    program: Program<'a>,
    diagnostics: Diagnostics,
    module_record: ModuleRecord<'a>,
    only_module_parse: bool,
}

/// Parses once, and retries in module mode when the first parse failed: a file that
/// only becomes valid as a module is one. Node.js's own syntax detection counts
/// top-level await as module syntax, so such a file reported as `commonjs` must not be
/// handed to the CommonJS machinery, which rejects it.
fn parse_source<'a>(
    allocator: &'a Allocator,
    source: &'a str,
    source_type: SourceType,
    allow_module_retry: bool,
) -> Parsed<'a> {
    let ParserReturn { program, diagnostics, module_record, .. } =
        Parser::new(allocator, source, source_type).parse();
    if allow_module_retry && source_type.is_unambiguous() && !diagnostics.is_empty() {
        let retry = Parser::new(allocator, source, source_type.with_module(true)).parse();
        if retry.diagnostics.is_empty() {
            return Parsed {
                program: retry.program,
                diagnostics: retry.diagnostics,
                module_record: retry.module_record,
                only_module_parse: true,
            };
        }
    }
    Parsed { program, diagnostics, module_record, only_module_parse: false }
}

// The callers pass a grab-bag of parse and transform decisions; grouping them into a
// struct would shuffle more code than it clarifies.
#[allow(clippy::too_many_arguments)]
fn oxc_transform<S: TryAsStr>(
    src_path: &Path,
    code: &S,
    compiler_options: Option<&CompilerOptions>,
    module_target: Option<Module>,
    enable_top_level_await: bool,
    is_es_module: bool,
    helper_module_name: Option<&str>,
    module_runner: Option<&mut ModuleRunner>,
) -> Result<(Output, bool)> {
    let allocator = Allocator::default();
    // `.js`, `.jsx`, `.ts`, `.tsx` and extensionless files are ambiguous: oxc decides
    // between a script and an ES module by looking for `import`/`export` syntax, so a
    // file that has none is treated as a script and the helper loader emits `require()`
    // for the helpers it injects. Node.js decides from the nearest `package.json`
    // instead and would then run that `require()` in an ES module. Only the caller
    // knows which it is, so let it say.
    let source_type = source_type_from_path(src_path).unwrap_or_default().with_module(is_es_module);
    let source = code.to_source()?;
    let source_str = strip_bom(&source);
    let allow_module_retry = !is_es_module
        && matches!(module_target, Some(Module::Preserve))
        && source_type.is_unambiguous();
    let Parsed { mut program, diagnostics, module_record, only_module_parse } =
        parse_source(&allocator, source_str, source_type, allow_module_retry);
    if !diagnostics.is_empty() {
        // `import`/`export` in a `.cts` file are checked in `transform_program`, once the
        // type-only ones are erased.
        if is_cts(source_type) && cts_uses_import_meta(source_str, source_type) {
            return Err(cts_module_syntax_error(src_path));
        }
        let msg = join_errors(diagnostics.into_vec(), source_str, src_path);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to parse {}:\n{}", src_path.display(), msg),
        ));
    }
    // A `.ts`/`.js` file inside a CommonJS package is reported as `commonjs`, but nothing
    // here downlevels ESM syntax — the module transform only rewrites TypeScript's
    // `import =` / `export =` — so a file that parsed as an ES module would reach Node.js
    // with its `import`/`export` declarations intact: as an entry point the `require(esm)`
    // retry is a self-cycle (`ERR_REQUIRE_CYCLE_MODULE`), and as an import it exposes no
    // named exports to `cjs-module-lexer`. Node.js runs the same file as an ES module when
    // it is `require()`d, so report it as one. Only the load-hook path can — it is the one
    // that reports a format back — and it passes `Module::Preserve`; the `pirates` hook and
    // the public API feed Node's CommonJS machinery, which has its own retry. Only the
    // ambiguous extensions may flip: `.cts`/`.cjs` are CommonJS by contract, and their
    // source type emits `require()` for helpers, which an ES module cannot run.
    let flip_to_module =
        only_module_parse || (allow_module_retry && parsed_as_esm(&program, &module_record));

    // `Module::Esm` and `Module::Preserve` emit identically for ES module input; the only
    // difference is that `Esm` makes the `import =` / `export =` lowerings report a
    // transform error instead of emitting a bare `require()` / `module.exports` that would
    // crash at run time in a file Node.js runs as ESM. tsc rejects the same constructs in
    // ES module output (TS1202/TS1203), and Node's own type stripping rejects them at load
    // time. A `.cts` file keeps `Preserve` — its `import =` needs `require()`.
    let effective_module =
        if is_es_module || flip_to_module { Some(Module::Esm) } else { module_target };

    let output = transform_program(
        &allocator,
        src_path,
        &mut program,
        source_str,
        compiler_options,
        effective_module,
        enable_top_level_await && !flip_to_module,
        helper_module_name,
        module_runner,
    )?;
    Ok((output, flip_to_module))
}

/// Semantic analysis, transform and codegen for an already-parsed program. Split from
/// parsing so the CommonJS sniff path can decide from the parse result and transform
/// straight away, without a second parse.
#[allow(clippy::too_many_arguments)]
fn transform_program<'a>(
    allocator: &'a Allocator,
    src_path: &Path,
    program: &mut Program<'a>,
    source_str: &str,
    compiler_options: Option<&CompilerOptions>,
    module_target: Option<Module>,
    enable_top_level_await: bool,
    helper_module_name: Option<&str>,
    mut module_runner: Option<&mut ModuleRunner>,
) -> Result<Output> {
    let legacy_decorators =
        compiler_options.and_then(|c| c.experimental_decorators).unwrap_or(false);
    if !legacy_decorators && has_decorator(program, source_str) {
        // A tsconfig only claims JavaScript files with `allowJs` (see
        // `TsconfigSource::for_importer`), so `experimentalDecorators` alone never reaches one.
        let allow_js =
            if program.source_type.is_javascript() { " and `\"allowJs\": true`" } else { "" };
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Failed to transform {}: decorators require `\"experimentalDecorators\": true`\
                 {allow_js} in a tsconfig.json that includes this file; standard (TC39) \
                 decorators are not supported yet",
                src_path.display()
            ),
        ));
    }

    // `with_enum_eval` pre-computes each enum member's value for the transformer.
    // Without it, a member that initializes another member (e.g. `Default = Theme.Light`)
    // emits a reverse mapping `Theme[Theme["Default"] = Theme.Light] = "Default"` that
    // overwrites the aliased key at run time (issue #795, oxc#21667); debug builds of
    // `oxc_transformer` assert on the missing flag outright.
    let scoping =
        SemanticBuilder::new().with_enum_eval(true).build(program).semantic.into_scoping();
    // Read before the transform: the TypeScript transform turns the source type into
    // JavaScript on its way out.
    let cts = is_cts(program.source_type);

    let use_define_for_class_fields = use_define_for_class_fields(compiler_options);
    // `useDefineForClassFields` selects `[[Define]]` semantics; oxc's `setPublicClassFields`
    // assumption selects the opposite, `[[Set]]`, so it is the negation of it.
    let set_public_class_fields = !use_define_for_class_fields;
    let legacy_decorators =
        compiler_options.and_then(|c| c.experimental_decorators).unwrap_or(false);
    // Every Node.js release with `module.register()` runs class fields, `#private` members
    // and static blocks natively, so they are only lowered where the emitted class has to
    // differ from the source: `[[Set]]` field semantics, and legacy decorators, which are
    // applied to the lowered class.
    let lower_class_features = set_public_class_fields || legacy_decorators;
    let TransformerReturn { diagnostics, .. } = Transformer::new(
        allocator,
        src_path,
        &TransformOptions {
            assumptions: CompilerAssumptions { set_public_class_fields, ..Default::default() },
            decorator: DecoratorOptions {
                legacy: legacy_decorators,
                emit_decorator_metadata: compiler_options
                    .and_then(|c| c.emit_decorator_metadata)
                    .unwrap_or(false),
                strict_null_checks: compiler_options
                    .and_then(|c| c.strict_null_checks)
                    .unwrap_or(false),
            },
            jsx: {
                // `compilerOptions.jsx` holds `tsc`'s values (`react`, `react-jsx`,
                // `react-jsxdev`, ...), not Babel's runtime names — mapping them is what
                // `jsx_runtime` is for. `(JsxRuntime::Automatic, false)` is `Default`, so
                // an unset option reproduces the automatic production runtime.
                let (runtime, development) = compiler_options
                    .and_then(|c| c.jsx.as_deref())
                    .map(jsx_runtime)
                    .unwrap_or_default();
                JsxOptions {
                    runtime,
                    development,
                    import_source: compiler_options.and_then(|c| c.jsx_import_source.clone()),
                    pragma: compiler_options.and_then(|c| c.jsx_factory.clone()),
                    pragma_frag: compiler_options.and_then(|c| c.jsx_fragment_factory.clone()),
                    ..Default::default()
                }
            },
            typescript: TypeScriptOptions {
                // `TypeScriptOptions` holds `Cow<'static, str>`, and the compiler
                // options are now borrowed per file rather than from a `OnceLock`,
                // so these have to be owned.
                jsx_pragma: compiler_options
                    .and_then(|c| c.jsx_factory.clone())
                    .map(Cow::Owned)
                    .unwrap_or_default(),
                jsx_pragma_frag: compiler_options
                    .and_then(|c| c.jsx_fragment_factory.clone())
                    .map(Cow::Owned)
                    .unwrap_or_default(),
                rewrite_import_extensions: compiler_options
                    .and_then(|c| c.rewrite_relative_import_extensions)
                    .unwrap_or_default()
                    .then_some(RewriteExtensionsMode::Rewrite),
                // `verbatimModuleSyntax` makes `tsc` (and Node's own type stripping)
                // emit every non-`type` import verbatim, even when the binding is
                // unused — the module's side effects still have to run. That is
                // exactly oxc's "only remove type imports" mode.
                only_remove_type_imports: compiler_options
                    .and_then(|c| c.verbatim_module_syntax)
                    .unwrap_or(false),
                // With `[[Set]]` semantics, `tsc` also drops class fields that have no
                // initializer instead of assigning `undefined` through the prototype chain
                // (which would fire an inherited setter). oxc only does that when asked.
                remove_class_fields_without_initializer: set_public_class_fields,
                ..Default::default()
            },
            env: EnvOptions {
                module: module_target.unwrap_or_default(),
                es2022: ES2022Options {
                    class_static_block: lower_class_features,
                    // `loose` stays `false`: it would also lower `#private` fields to
                    // string-keyed properties, which `tsc` never does. The assumption
                    // above alone selects `[[Set]]` for public fields — the transformer
                    // ORs the two together.
                    class_properties: lower_class_features.then(ClassPropertiesOptions::default),
                    // Turn this on would throw error for all top-level awaits; the caller
                    // clears it for a file flipping to an ES module, which keeps them.
                    top_level_await: enable_top_level_await,
                },
                es2026: ES2026Options {
                    explicit_resource_management: !NATIVE_EXPLICIT_RESOURCE_MANAGEMENT
                        .load(Ordering::Relaxed),
                },
                ..Default::default()
            },
            proposals: ProposalOptions {},
            helper_loader: HelperLoaderOptions {
                // The module name carries a tag for the loading copy when one was given —
                // `@oxc-node/core@<tag>/helpers/x` — so several registered copies each get
                // their own helpers back instead of racing on one shared specifier. The
                // resolve side maps it to `@oxc-node/core`'s real `exports` subpath.
                module_name: helper_module_name
                    .map_or(Cow::Borrowed("@oxc-node/core"), |name| Cow::Owned(name.to_owned())),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .build_with_scoping(scoping, program);

    if !diagnostics.is_empty() {
        // An ES module with top-level await cannot become CommonJS. `require()` of
        // one is Node.js' `ERR_REQUIRE_ASYNC_MODULE`, which code catches to fall back
        // to `import()` (issue #842); a CommonJS file's top-level await is a syntax
        // error to Node.js instead.
        if matches!(module_target, Some(Module::CommonJS))
            && enable_top_level_await
            && has_top_level_await(program)
            && !is_commonjs_file(src_path)
        {
            return Err(require_async_module_error(src_path));
        }
        let msg = join_errors(diagnostics.into_vec(), source_str, src_path);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to transform {}:\n{}", src_path.display(), msg),
        ));
    }

    if cts {
        // What is left of the `import`/`export` declarations once the type-only ones are
        // erased is ES module syntax that nothing here compiles to CommonJS.
        if has_cts_module_declaration(program) {
            return Err(cts_module_syntax_error(src_path));
        }
        // The empty `export {}` the transform appends when it erases a file's last
        // `import`/`export` would make Node.js detect module syntax and run the file as an
        // ES module, without `require` or `module`. It exports nothing, so drop it.
        program.body.retain(|statement| {
            !matches!(statement, Statement::ExportNamedDeclaration(decl) if decl.specifiers.is_empty())
        });
    }

    let esm = matches!(module_target, Some(Module::Esm));
    if let Some(runner) = module_runner.as_deref_mut() {
        runner.esm = esm;
        // Read before the runner transform, whose imports are awaits of their own.
        runner.top_level_await = esm && has_top_level_await(program);
        // The runner evaluates the code as a function body, where `#!` is a syntax error.
        program.hashbang = None;
        split_namespace_imports(allocator, program);
        let scoping = SemanticBuilder::new().build(program).semantic.into_scoping();
        ModuleRunnerTransform::new().transform(allocator, program, scoping);
        unmap_hoisted_exports(program);
        if runner.sync && !runner.top_level_await {
            drop_import_awaits(allocator, program);
        }
    }

    let CodegenReturn { code, map, .. } = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(src_path.to_path_buf()),
            ..Default::default()
        })
        .build(program);
    let map = map.map(|source_map| source_map.into_owned());
    if module_runner.is_some() {
        let (code, map) = retain_lines(code, map, esm);
        return Ok(Output { code, map });
    }
    Ok(Output { code, map })
}

/// What the module runner asks of [`transform_program`] on top of the normal
/// transform, and what it learns about the file.
#[derive(Default)]
struct ModuleRunner {
    /// Emit static imports without `await`, for `require()` of an ES module. A module
    /// with top-level await keeps them: it cannot run synchronously at all.
    sync: bool,
    /// The file is an ES module: the same decision the load hook makes for it.
    esm: bool,
    /// The ES module awaits at its top level.
    top_level_await: bool,
}

const SSR_EXPORTS: &str = "__vite_ssr_exports__";
const SSR_IMPORT: &str = "__vite_ssr_import__";

/// The runner transform puts one `Object.defineProperty(__vite_ssr_exports__, ...)` per
/// export at the top, each spanning its export: often a line far below, such as an
/// `export { a, b }` at the end of the file. Mapped, they would push the whole file
/// down in [`retain_lines`]. They never throw, so they lose their mappings.
fn unmap_hoisted_exports(program: &mut Program<'_>) {
    struct Unmap;

    impl<'a> VisitMut<'a> for Unmap {
        fn visit_span(&mut self, span: &mut Span) {
            *span = SPAN;
        }
    }

    for statement in &mut program.body {
        let Statement::ExpressionStatement(expression) = statement else { break };
        let Expression::CallExpression(call) = &expression.expression else { break };
        let defines_export = call.callee.as_member_expression().is_some_and(|member| {
            member.object().is_specific_id("Object")
                && member.static_property_name().is_some_and(|name| name == "defineProperty")
        }) && call
            .arguments
            .first()
            .and_then(Argument::as_expression)
            .is_some_and(|target| target.is_specific_id(SSR_EXPORTS));
        if !defines_export {
            break;
        }
        Unmap.visit_statement(statement);
    }
}

/// The runner transform drops the default binding of `import a, * as b from "x"`, so
/// the declaration is split first: `import a from "x"; import * as b from "x";`.
fn split_namespace_imports<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    let mut index = 0;
    while index < program.body.len() {
        if let Statement::ImportDeclaration(declaration) = &mut program.body[index]
            && let Some(specifiers) = &mut declaration.specifiers
            && specifiers.len() > 1
            && matches!(
                specifiers.last(),
                Some(ImportDeclarationSpecifier::ImportNamespaceSpecifier(_))
            )
            && let Some(namespace) = specifiers.pop()
        {
            let mut split = declaration.clone_in(allocator);
            split.specifiers = Some(oxc::allocator::Vec::from_array_in([namespace], &allocator));
            program.body.insert(index + 1, Statement::ImportDeclaration(split));
            index += 1;
        }
        index += 1;
    }
}

/// Turns each `const x = await __vite_ssr_import__(...)` the runner transform hoists
/// into a plain call, so that the module body runs synchronously.
fn drop_import_awaits<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    for statement in &mut program.body {
        let Statement::VariableDeclaration(declaration) = statement else { continue };
        for declarator in &mut declaration.declarations {
            let Some(Expression::AwaitExpression(init)) = &mut declarator.init else { continue };
            let imports = matches!(
                &init.argument,
                Expression::CallExpression(call) if call.callee.is_specific_id(SSR_IMPORT)
            );
            if imports {
                declarator.init = Some(init.argument.take_in(&allocator));
            }
        }
    }
}

/// Moves the generated code's lines so that each starts on the line of the source it
/// came from, as Babel's `retainLines` does. A stack frame then names the source line
/// even where no source map is applied: the runner evaluates the code itself, and
/// Node.js only maps stack traces for it under `--enable-source-maps`.
///
/// A line is pushed down with extra line breaks, and joined to the line before when the
/// output has run ahead of the source. A line break is only removed where JavaScript
/// does not see it: never inside a string, a template or a comment, nor at the end of a
/// line comment. The generated code always ends its statements with `;`, so automatic
/// semicolon insertion has no say. The source map moves with the code.
fn retain_lines(
    code: String,
    map: Option<SourceMap<'static>>,
    esm: bool,
) -> (String, Option<SourceMap<'static>>) {
    struct Protected(Vec<(u32, u32)>);

    impl<'a> Visit<'a> for Protected {
        fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
            self.0.push((it.span.start, it.span.end));
        }

        fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
            self.0.push((it.span.start, it.span.end));
        }
    }

    let Some(map) = map else { return (code, None) };
    let line_starts: Vec<usize> =
        iter::once(0).chain(memchr::memchr_iter(b'\n', code.as_bytes()).map(|at| at + 1)).collect();
    let line_count = line_starts.len();

    // The first source line each generated line maps to.
    let mut targets: Vec<Option<u32>> = vec![None; line_count];
    for token in map.get_tokens() {
        if token.get_source_id().is_none() {
            continue;
        }
        let target = &mut targets[token.get_dst_line() as usize];
        if target.is_none() {
            *target = Some(token.get_src_line());
        }
    }

    // Which line breaks can move. One inside a string or a template is part of its value
    // and stays exactly as it is; one inside a comment, or ending a line comment, has to
    // stay but may be joined by more.
    let (fixed, kept) = {
        let allocator = Allocator::default();
        let source_type = if esm { SourceType::mjs() } else { SourceType::cjs() };
        let ParserReturn { program, diagnostics, .. } =
            Parser::new(&allocator, &code, source_type).parse();
        if !diagnostics.is_empty() {
            return (code, Some(map));
        }
        let mut literals = Protected(Vec::new());
        literals.visit_program(&program);
        let comments = program
            .comments
            .iter()
            .map(|comment| {
                // A line comment's break ends it, so it counts as part of the comment.
                let end = if comment.is_line() { comment.span.end + 1 } else { comment.span.end };
                (comment.span.start, end)
            })
            .collect();
        (breaks_inside(&line_starts, literals.0), breaks_inside(&line_starts, comments))
    };

    let utf16_len = |text: &str| {
        if text.is_ascii() { text.len() as u32 } else { text.encode_utf16().count() as u32 }
    };
    let mut output = String::with_capacity(code.len());
    // Per generated line: the output line it lands on, and how far its columns move.
    let mut moves: Vec<(u32, i64)> = Vec::with_capacity(line_count);
    let mut out_line = 0;
    let mut out_column: i64 = 0;
    for line in 0..line_count {
        let end = line_starts.get(line + 1).map_or(code.len(), |next| next - 1);
        let raw = &code[line_starts[line]..end];
        let push_down = targets[line].filter(|&target| target > out_line);
        let text = if line > 0 && fixed[line - 1] {
            output.push('\n');
            out_line += 1;
            out_column = 0;
            raw
        } else if line > 0 && kept[line - 1] {
            let target = push_down.unwrap_or(out_line + 1).max(out_line + 1);
            output.extend(iter::repeat_n('\n', (target - out_line) as usize));
            out_line = target;
            out_column = 0;
            raw
        } else if let Some(target) = push_down {
            output.extend(iter::repeat_n('\n', (target - out_line) as usize));
            out_line = target;
            out_column = 0;
            raw
        } else if line > 0 {
            output.push(' ');
            out_column += 1;
            raw.trim_start()
        } else {
            raw
        };
        let trimmed = i64::from(utf16_len(&raw[..raw.len() - text.len()]));
        moves.push((out_line, out_column - trimmed));
        out_column += i64::from(utf16_len(text));
        output.push_str(text);
    }

    let mut parts = map.into_parts();
    parts.tokens = parts
        .tokens
        .iter()
        .map(|token| {
            let (line, shift) = moves[token.get_dst_line() as usize];
            let column = (i64::from(token.get_dst_col()) + shift).max(0) as u32;
            Token::new(
                line,
                column,
                token.get_src_line(),
                token.get_src_col(),
                token.get_source_id(),
                token.get_name_id(),
            )
        })
        .collect();
    parts.token_chunks = None;
    (output, Some(SourceMap::from_parts(parts)))
}

/// For each line break after the first line, whether it falls inside one of `ranges`.
fn breaks_inside(line_starts: &[usize], mut ranges: Vec<(u32, u32)>) -> Vec<bool> {
    ranges.sort_unstable();
    let mut ranges = ranges.into_iter().peekable();
    let mut furthest = 0;
    line_starts[1..]
        .iter()
        .map(|&start| {
            let at = (start - 1) as u32;
            while let Some(&(range_start, range_end)) = ranges.peek() {
                if range_start >= at {
                    break;
                }
                furthest = furthest.max(range_end);
                ranges.next();
            }
            at < furthest
        })
        .collect()
}

// The `#[napi(object)]` macros stay unconditional with `napi` off: they emit
// no registrations, only `FromNapiValue`/`ToNapiValue` impls an embedder's
// forwarders reuse — and a type-def file `napi build` then folds into the
// host's `index.d.ts` (see the `napi` feature docs in Cargo.toml).
#[napi(object)]
#[derive(Debug)]
pub struct ResolveContext {
    /// Export conditions of the relevant `package.json`
    pub conditions: Vec<String>,
    /// An object whose key-value pairs represent the assertions for the module to import
    pub import_attributes: HashMap<String, String>,

    #[napi(js_name = "parentURL")]
    pub parent_url: Option<String>,
}

#[napi(object)]
pub struct ResolveFnOutput {
    pub format: Option<Either<String, Null>>,
    pub short_circuit: Option<bool>,
    pub url: String,
    pub import_attributes: Option<Either<HashMap<String, String>, Null>>,
}

#[cfg_attr(not(target_family = "wasm"), napi(object, object_from_js = false, object_to_js = false))]
#[cfg_attr(target_family = "wasm", napi(object, object_to_js = false))]
pub struct OxcResolveOptions {
    pub get_current_directory: Option<FunctionRef<(), String>>,
}

#[cfg(not(target_family = "wasm"))]
impl FromNapiValue for OxcResolveOptions {
    unsafe fn from_napi_value(_: sys::napi_env, _value: sys::napi_value) -> Result<Self> {
        Ok(OxcResolveOptions { get_current_directory: None })
    }
}

#[cfg_attr(feature = "napi", napi)]
#[cfg_attr(not(target_family = "wasm"), allow(unused_variables))]
#[allow(clippy::type_complexity)]
pub fn create_resolve<'env>(
    env: &'env Env,
    options: OxcResolveOptions,
    specifier: String,
    context: ResolveContext,
    next_resolve: Function<
        'env,
        FnArgs<(String, Option<ResolveContext>)>,
        Either<ResolveFnOutput, PromiseRaw<'env, ResolveFnOutput>>,
    >,
) -> Result<Either<ResolveFnOutput, PromiseRaw<'env, ResolveFnOutput>>> {
    let _environment = LoaderEnvironmentGuard::from_env(env)?;
    tracing::debug!(specifier = ?specifier, context = ?context);
    // The URL parser removes ASCII tab or newline characters before
    // parsing, so file-URL classification and conversion see the cleaned
    // spelling — `fi\tle://…` is a file URL like any other. Every other
    // specifier keeps its original spelling: Node hands `no\tde:fs` to the
    // hook unchanged, and rewriting `lo\tdash` would resolve the wrong
    // package.
    #[cfg(windows)]
    let cleaned;
    #[cfg(windows)]
    let file_specifier = if memchr::memchr3(b'\t', b'\n', b'\r', specifier.as_bytes()).is_some() {
        cleaned = specifier.replace(['\t', '\n', '\r'], "");
        cleaned.as_str()
    } else {
        specifier.as_str()
    };
    #[cfg(not(windows))]
    let file_specifier = specifier.as_str();
    if specifier.starts_with("node:") || specifier.starts_with("nodejs:") {
        tracing::debug!("short-circuiting builtin protocol resolve: {}", specifier);
        return add_short_circuit(specifier, Some("builtin"), context, next_resolve);
    }
    if BUILTIN_MODULES.contains(specifier.as_str()) {
        tracing::debug!("short-circuiting builtin resolve: {}", specifier);
        return add_short_circuit(specifier, Some("builtin"), context, next_resolve);
    }
    // A `data:` URL is no built-in module: `builtin` sent Node.js looking it up as one
    // (`ERR_UNKNOWN_BUILTIN_MODULE`). Node.js derives the format from the MIME type,
    // so its answer is kept as it is (issue #841).
    if specifier.starts_with("data:") {
        tracing::debug!("short-circuiting data URL resolve: {}", specifier);
        return add_short_circuit(specifier, None, context, next_resolve);
    }
    #[cfg(target_family = "wasm")]
    let cwd = {
        if let Some(get_cwd) = options.get_current_directory {
            Path::new(get_cwd.borrow_back(&env)?.call(())?.as_str()).to_path_buf()
        } else {
            Path::new("/").to_path_buf()
        }
    };

    #[cfg(not(target_family = "wasm"))]
    let cwd = env::current_dir()?;

    let context_state = loader_context();
    let (base_resolver, tsconfig_source) =
        context_state.resolver_and_tsconfig.get_or_init(|| init_resolver(cwd.clone()));

    // A `file:` URL is an absolute path in every form Node.js hands over,
    // UNC `file://server/…` included. Schemes are case-insensitive, so
    // `FILE://…` qualifies too; only the Windows UNC handling needs that
    // spelling, so other platforms keep the plain prefix check.
    #[cfg(windows)]
    let is_absolute_path =
        file_specifier.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file://"));
    #[cfg(not(windows))]
    let is_absolute_path = file_specifier.starts_with("file://");

    // The path of the parent URL, a file or a directory.
    let parent =
        match context.parent_url.as_deref() {
            Some(parent) => Some(file_url_to_path(parent).ok_or_else(|| {
                Error::new(Status::GenericFailure, "Parent URL is not a file URL")
            })?),
            None => None,
        };
    let parent = parent.as_deref();
    // A parent URL that ends in `/` is the directory to resolve from, not a file:
    // Node.js resolves `--import` preloads from `pathToFileURL(cwd + "/")`, which
    // is `file:///` when the working directory is `/` (issue #862).
    let parent_is_directory = context.parent_url.as_deref().is_some_and(|parent| {
        let path = url_path(parent);
        path.ends_with('/') || path.ends_with('\\')
    });
    // The importing file itself, when the parent URL is a file's. Discovery
    // needs the file rather than its directory, because `TsconfigDiscovery::Auto`
    // matches a config's `files` / `include` / `exclude` against the file path.
    // A directory parent has no file to discover from, as the entry point has not.
    let parent_file = parent.filter(|_| !parent_is_directory);

    let in_node_modules =
        |path: &Path| path.to_str().is_some_and(|path| path.contains(NODE_MODULES_PATH));
    let order = extension_order(parent, parent_file);
    // Node.js keeps a symlinked path under `--preserve-symlinks`, and the entry
    // point's under `--preserve-symlinks-main` (issue #845). Only the entry point
    // has no parent URL: a preload's parent is the working directory.
    let preserve = preserve_symlinks(env);
    let symlinks = !if parent.is_none() {
        preserve.preserve_symlinks_main
    } else {
        preserve.preserve_symlinks
    };
    let resolver = resolver_for_conditions(base_resolver, &context.conditions, order, symlinks);
    let resolver = resolver.as_ref();

    let directory = match parent {
        Some(directory) if parent_is_directory => directory,
        Some(parent_file) => parent_file
            .parent()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Parent URL is not a file URL"))?,
        None => cwd.as_path(),
    };
    tracing::debug!(directory = ?directory);

    // What the resolver is asked for — the directory to resolve from and the
    // specifier — or `None` when it cannot be asked exactly and Node's own
    // resolution has to answer, and the `?query` / `#fragment` the resolved URL
    // carries. A file URL — and, in ESM, a relative or absolute-path specifier —
    // is a URL reference: its pathname is percent-encoded (`./dep%23x.ts` names
    // `dep#x.ts`) and a raw `?` or `#` starts its query or fragment (issues
    // #837, #856). The resolver reads specifiers as paths, so the pathname is
    // decoded here and its characters escaped, and the query and fragment are
    // kept back from it and put on the URL it resolves to, as Node.js does. An
    // encoded separator or a malformed escape is never decoded: Node rejects it.
    // `require()` never gets here: `register.mjs` leaves it to Node.js' own
    // CommonJS resolution, which reads its specifier as a path.
    let is_path_reference = specifier.starts_with("./")
        || specifier.starts_with("../")
        // `//host/…` is a network-path reference whose first segment is the
        // file URL's host, not a directory: Node's URL resolver answers it.
        || specifier.starts_with('/') && !matches!(specifier.as_bytes().get(1), Some(b'/' | b'\\'));
    let mut suffix = "";
    let request = if is_absolute_path {
        let pathname = url_path(file_specifier);
        if has_encoded_separator(pathname) || has_malformed_escape(pathname) {
            None
        } else {
            let specifier_path = file_url_to_path(file_specifier)
                .ok_or_else(|| Error::new(Status::GenericFailure, "Specifier is not a file URL"))?;
            suffix = &file_specifier[pathname.len()..];
            resolver_request(Path::new("/"), &specifier_path.to_string_lossy())
        }
    } else if is_path_reference
        // `memchr3` takes at most three bytes, and two passes still beat one
        // pass of a `char` set, which decodes every character.
        && (memchr::memchr3(b'%', b'\\', b'?', specifier.as_bytes()).is_some()
            || memchr::memchr(b'#', specifier.as_bytes()).is_some())
    {
        let pathname = url_path(&specifier);
        if has_encoded_separator(pathname) || has_malformed_escape(pathname) {
            None
        } else {
            suffix = &specifier[pathname.len()..];
            // A raw `\` is a `/` to the URL parser (`./dir\a.ts` names
            // `dir/a.ts`), while the resolver would read it as a POSIX
            // file-name character. Escapes that do not decode to UTF-8
            // (`%FF`) are malformed to Node too.
            let pathname_slashes = pathname.replace('\\', "/");
            decode_url_path(&pathname_slashes)
                .and_then(|decoded| resolver_request(directory, &decoded))
        }
    } else {
        Some((Cow::Borrowed(directory), Cow::Borrowed(specifier.as_str())))
    };
    // The resolved file's URL, with the query and fragment kept back above.
    let url_of = |resolution: &Resolution| {
        let mut url = oxc_resolved_path_to_url(resolution);
        url.push_str(suffix);
        url
    };

    let resolve =
        |resolver: &Resolver| match (&request, is_absolute_path, tsconfig_source, parent_file) {
            // The fallback below hands the specifier to Node's own resolution,
            // which reads the URL exactly or raises Node's own error.
            (None, ..) => Err(ResolveError::NotFound(specifier.clone())),
            (Some((directory, resolver_specifier)), true, ..) => {
                resolver.resolve(directory, resolver_specifier)
            }
            // `Resolver::resolve` only ever consults a *manually* configured tsconfig,
            // so under `TsconfigDiscovery::Auto` it would silently ignore `paths` and
            // `baseUrl`. The obvious alternative, `resolve_file`, rediscovers the
            // config itself, which would bypass `for_path` — losing both its
            // JavaScript probe and its "a broken ancestor config means no config"
            // error handling. `resolve_with_context` is the API that takes an
            // already-resolved config, so the importer's config is worked out once,
            // in one place, and handed straight to the resolver. The entry-point
            // case (no parent URL, only a working directory) has no file to discover
            // from and still goes through `resolve`.
            (
                Some((directory, resolver_specifier)),
                false,
                TsconfigSource::Auto,
                Some(parent_file),
            ) => {
                let tsconfig = tsconfig_source.for_importer(resolver, parent_file, &specifier);
                resolver.resolve_with_context(
                    directory,
                    resolver_specifier,
                    tsconfig.as_deref(),
                    &mut ResolverContext::default(),
                )
            }
            (Some((directory, resolver_specifier)), ..) => {
                resolver.resolve(directory, resolver_specifier)
            }
        };
    let mut resolution = resolve(resolver);
    // oxc's own answer, before any fallback below.
    let failed = resolution.is_err();
    // TypeScript first is for the project's own files. A package that ships its
    // `.ts` (or `.jsx`) sources beside the compiled `.js` is still run from what
    // it compiled, as it is when the package imports itself. When the source
    // or named order lands on an extension it tries ahead of the package order,
    // the request is resolved again with the package order. Any other result means
    // the files tried before it are absent, so the package order picks it too,
    // except for a `.jsx` specifier that lands on `.js`: the package order has
    // no `.jsx` alias, and the `.js` is kept, as tsc and tsx resolve it.
    if order != ExtensionOrder::Package
        && let Ok(resolved) = &resolution
        && in_node_modules(resolved.path())
        && resolved
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| SOURCE_FIRST_EXTENSIONS.contains(&ext))
    {
        let package_resolver = resolver_for_conditions(
            base_resolver,
            &context.conditions,
            ExtensionOrder::Package,
            symlinks,
        );
        resolution = resolve(&package_resolver);
    }

    // A file that does not exist yet can still be created, so a watch parent
    // learns every path the resolver tried (`x.ts` for `./x.js`, `dir/index.ts`,
    // a `paths` alias's targets). It runs ahead of the early returns below, so a
    // request with import attributes (`./data.json` with `type: "json"`) is
    // covered too. The paths are asked of the resolver again rather than
    // collected on every resolve, which keeps the hot path as it is: only a
    // failure while watching pays for the second run.
    if watching()
        && failed
        && !parent.is_some_and(in_node_modules)
        && let Some((directory, resolver_specifier)) = &request
    {
        // The config the failed resolve used.
        let tsconfig = match (tsconfig_source, parent_file, is_absolute_path) {
            (TsconfigSource::Manual(tsconfig), ..) => tsconfig.clone(),
            (TsconfigSource::Auto, Some(parent_file), false) => {
                tsconfig_source.for_importer(resolver, parent_file, &specifier)
            }
            _ => None,
        };
        let mut resolve_context = ResolverContext::default();
        let _ = resolver.resolve_with_context(
            directory,
            resolver_specifier,
            tsconfig.as_deref(),
            &mut resolve_context,
        );
        for path in watch_candidates(&resolve_context.missing_dependencies) {
            report_watch_path(path);
        }
    }

    // JSON modules, resolved with oxc-node's own resolver so that tsconfig `paths`, package
    // `exports` and conditions apply to them like they do to everything else. Deciding this
    // from the specifier before resolving, as this used to, meant an aliased or exported
    // JSON path was handed to Node.js unresolved.
    //
    // Node.js wants `json` when the caller wrote an import attribute. Without one it would
    // refuse to load the module at all, so report `module` and let `load` synthesise a
    // default export plus one named export per key.
    if let Ok(resolved) = &resolution
        && resolved.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        let format = json_format(&context);
        tracing::debug!("resolved JSON {} as format: {}", specifier, format);
        let url = url_of(resolved);
        return add_short_circuit(url, Some(format), context, next_resolve);
    }

    // Import attributes are Node.js' own business, so a request carrying any
    // keeps its resolution — except the format answer: `module-typescript`
    // and `commonjs-typescript` send a dependency this process transforms
    // back to Node.js' type-stripping translator, which refuses
    // `node_modules` outright before `load` can run (issue #821).
    if !context.import_attributes.is_empty() {
        tracing::debug!(
            "short-circuiting import attributes resolve: {}, attributes: {:?}",
            specifier,
            context.import_attributes
        );
        return fixup_typescript_dep_format(next_resolve.call((specifier, Some(context)).into())?);
    };

    if let Ok(resolution) = resolution {
        tracing::debug!(resolution = ?resolution, "resolved");
        let p = resolution.path();
        let url = url_of(&resolution);
        // `node_modules` files keep the `null` format so Node.js delegates `load`
        // to its own implementation — the load hook cannot report "skip"
        // otherwise (see #189). The exception: files this process is asked to
        // transform anyway get our format, because Node.js' own answer for
        // them would never reach `load` — `.ts`/`.cts`/`.mts` die with
        // `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` and the rest with
        // `ERR_UNKNOWN_FILE_EXTENSION`. Formats Node.js runs as-is (`.js`,
        // `.wasm`, addons) stay deferred either way.
        let transformable_dependency =
            || deps_mode().resolves_format(p.extension().and_then(|ext| ext.to_str()));
        if !p.to_str().map(|p| p.contains(NODE_MODULES_PATH)).unwrap_or(false)
            || transformable_dependency()
        {
            let format = {
                let ext = p.extension().and_then(|ext| ext.to_str());

                let format = ext
                    .and_then(|ext| match ext {
                        "cjs" | "cts" | "node" => Some("commonjs"),
                        "mts" | "mjs" => Some("module"),
                        _ => {
                            // The format describes the *resolved* file, so it is
                            // that file's own tsconfig that decides, not the
                            // importer's.
                            if (ext == "ts" || ext == "tsx")
                                && let Some(default_module) = default_module_from_tsconfig(
                                    tsconfig_source.for_path(resolver, p).as_deref(),
                                )
                            {
                                return Some(default_module);
                            }
                            match resolution.module_type() {
                                Some(ModuleType::Module) => Some("module"),
                                Some(ModuleType::CommonJs) => Some("commonjs"),
                                // `.wasm` and other non-JavaScript formats have their
                                // own answer; keep the previous CommonJS default
                                // rather than reclassify them by package type.
                                Some(_) => Some("commonjs"),
                                // `esm_file_format` consults the package `type` only
                                // for `.js`/`.ts`, and Node's own ESM_FILE_FORMAT
                                // also answers with it for extensionless files.
                                // Extend the fallback to the other source
                                // extensions oxc registers; every other extension
                                // keeps the CommonJS default.
                                None => match ext {
                                    "js" | "ts" | "jsx" | "tsx" | "es" | "es6" => None,
                                    _ => Some("commonjs"),
                                },
                            }
                        }
                    })
                    // Extensions the loader accepts but the resolver does not
                    // classify (`.jsx`/`.tsx`/`.es`/`.es6`), plus extensionless
                    // files, fall back to the resolved package.json `type`:
                    // `"type": "module"` files run as ESM.
                    .or_else(|| {
                        resolution
                            .package_json()
                            .and_then(|package_json| package_json.r#type())
                            .map(|ty| match ty {
                                PackageType::Module => "module",
                                PackageType::CommonJs => "commonjs",
                            })
                    })
                    .unwrap_or("commonjs");
                tracing::debug!(path = ?p, format = ?format);
                format
            };
            return add_short_circuit(url, Some(format), context, next_resolve);
        } else {
            return add_short_circuit(url, None, context, next_resolve);
        }
    }

    tracing::debug!("default resolve: {}", specifier);

    if url_path(&specifier).ends_with(".json") {
        // oxc-node's resolver has nothing to add for this one; keep reporting the format so
        // Node.js can load it, exactly as before.
        let format = json_format(&context);
        return add_short_circuit(specifier, Some(format), context, next_resolve);
    }

    // oxc's resolver failed, so the answer — the format included — is whatever
    // Node.js' own resolution makes of it. A TypeScript dependency still has
    // to lose its `*-typescript` format (see the import-attributes branch).
    fixup_typescript_dep_format(add_short_circuit(specifier, None, context, next_resolve)?)
}

/// The format to report for a JSON module: `json` when the caller wrote an import
/// attribute, `module` otherwise so that [`load`] can synthesise its named exports.
fn json_format(context: &ResolveContext) -> &'static str {
    if context.import_attributes.contains_key("type") { "json" } else { "module" }
}

// Same rationale as `ResolveContext` above: kept compiled for marshalling
// reuse under `default-features = false`.
#[napi(object)]
#[derive(Debug)]
pub struct LoadContext {
    /// Export conditions of the relevant `package.json`
    pub conditions: Option<Vec<String>>,
    /// The format optionally supplied by the `resolve` hook chain. Node.js passes it as
    /// `undefined`, not `null`, when the chain reported none — a `.node` or `.wasm` file
    /// resolved without its flag, any extension Node.js does not know — and a required
    /// field would reject the whole context with "Missing field `format`" instead of
    /// letting Node.js raise its own `ERR_UNKNOWN_FILE_EXTENSION`.
    pub format: Option<Either<String, Null>>,
    /// An object whose key-value pairs represent the assertions for the module to import
    pub import_attributes: HashMap<String, String>,
}

#[napi(object)]
pub struct LoadFnOutput {
    pub format: String,
    pub source: Option<Either4<String, Uint8Array, Buffer, Null>>,
    #[napi(js_name = "responseURL")]
    pub response_url: Option<String>,
}

#[cfg_attr(feature = "napi", napi)]
#[allow(clippy::type_complexity)]
pub fn load<'env>(
    url: String,
    context: LoadContext,
    next_load: Function<
        'env,
        FnArgs<(String, Option<LoadContext>)>,
        Either<LoadFnOutput, PromiseRaw<'env, LoadFnOutput>>,
    >,
    helper_module_name: Option<String>,
) -> Result<Either<LoadFnOutput, PromiseRaw<'env, LoadFnOutput>>> {
    tracing::debug!(url = ?url, context = ?context, "load");
    if url.starts_with("data:") || {
        match context.format {
            Some(Either::A(ref format)) => {
                format == "builtin" || format == "json" || format == "wasm"
            }
            _ => true,
        }
    } {
        tracing::debug!("short-circuiting load: {}", url);
        return next_load.call((url, Some(context)).into());
    }

    let loaded = next_load.call((url.clone(), Some(context)).into())?;
    let context_state = loader_context();
    let (resolver, tsconfig_source) = context_state
        .resolver_and_tsconfig
        .get()
        .ok_or_else(|| Error::new(Status::GenericFailure, "Failed to get resolver and tsconfig"))?;

    // `url` is a `file://` URL here. Auto discovery needs the plain absolute
    // path: `find_tsconfig` bails out on anything that is not absolute, so
    // handing it the URL would silently yield no config for every file.
    let source_path = file_url_to_path(&url);
    let tsconfig = tsconfig_source
        .for_path(resolver, source_path.as_deref().unwrap_or_else(|| Path::new(url.as_str())));

    match loaded {
        Either::A(output) => Ok(Either::A(transform_output(
            url,
            output,
            tsconfig.as_ref().map(|tsconfig| &tsconfig.compiler_options),
            helper_module_name,
        )?)),
        // The config is owned, so move it into the callback and borrow from it
        // there; the callback outlives this function and must be `'static`.
        Either::B(promise) => promise
            .then(move |ctx| {
                transform_output(
                    url,
                    ctx.value,
                    tsconfig.as_ref().map(|tsconfig| &tsconfig.compiler_options),
                    helper_module_name,
                )
            })
            .map(Either::B),
    }
}

/// Node.js does not read CommonJS modules for the `load` hook: its default load returns
/// no source and lets the CJS machinery fetch the file later. The format was decided from
/// the outside, though — a `.ts`/`.js` or extensionless file in a CommonJS package that
/// contains ESM syntax is an ES module to Node.js (it runs as one when `require()`d), and
/// reporting it as `commonjs` breaks both entry points (`ERR_REQUIRE_CYCLE_MODULE`) and
/// named imports (`cjs-module-lexer` finds no exports). Check what the source really is,
/// transforming it right away when it is an ES module; anything else falls through
/// untouched. The source is the file read from disk — or, when the caller already
/// holds source for the URL, that source, and the file is not read at all. The
/// synchronous default load hands over the file's own bytes, so the read is usually
/// spared on the file's own content; a previous hook's differing source decides the
/// flip instead of the file. The parse is shared with the transform, so a flipped
/// file is parsed once.
fn load_commonjs_esm(
    url: &str,
    output: &LoadFnOutput,
    source: Option<&str>,
    resolved_compiler_options: Option<&CompilerOptions>,
    helper_module_name: Option<String>,
) -> Result<Option<LoadFnOutput>> {
    if output.format != "commonjs" {
        return Ok(None);
    }
    // A `?query` or `#fragment` suffix belongs to the module URL, not to the file on disk.
    let Some(path) = file_url_to_path(url_path(url)) else { return Ok(None) };
    // The same skip as the transform below: dependencies are left alone unless asked for.
    if url.contains("/node_modules/")
        && !deps_mode().transforms(path.extension().and_then(|ext| ext.to_str()))
    {
        return Ok(None);
    }
    let Some(source_type) = source_type_from_path(&path) else { return Ok(None) };
    if is_cts(source_type) {
        return reject_cts_module_syntax(&path, source, resolved_compiler_options);
    }
    // Only the ambiguous extensions — and extensionless files, whose module kind Node.js
    // decides from syntax — may flip: `.cts`/`.cjs` are CommonJS by contract, and their
    // source type emits `require()` for helpers, which an ES module cannot run.
    if !source_type.is_unambiguous() {
        return Ok(None);
    }
    // `read_to_string` would validate UTF-8 with std's scalar check; the SIMD pass is the
    // one `file_url_to_path` uses, and borrowing the bytes skips the copy into a String.
    // When the caller already holds the source it is a `&str` — UTF-8 by construction —
    // and the file never gets read.
    let bytes;
    let source = match source {
        Some(source) => source,
        None => {
            let Ok(file) = std::fs::read(&path) else { return Ok(None) };
            bytes = file;
            let Ok(source) = simdutf8::basic::from_utf8(&bytes) else { return Ok(None) };
            source
        }
    };
    let source = strip_bom(source);
    let allocator = Allocator::default();
    // `only_module_parse` covers the shapes oxc cannot resolve on its own, such as a
    // top-level `for await`; `parsed_as_esm` covers the rest, including top-level await.
    let Parsed { mut program, diagnostics, module_record, only_module_parse } =
        parse_source(&allocator, source, source_type, true);
    if !(only_module_parse || parsed_as_esm(&program, &module_record)) {
        return Ok(None);
    }
    // From here on the file is handed back as an ES module, so surface parse errors
    // exactly as the source-bearing path would.
    if !diagnostics.is_empty() {
        let msg = join_errors(diagnostics.into_vec(), source, &path);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to parse {}:\n{}", path.display(), msg),
        ));
    }
    // A module keeps its top-level awaits, hence the last `false`. `Module::Esm` emits
    // identically to `Preserve` for ES module input but reports the `import =` /
    // `export =` lowerings as transform errors instead of emitting bare `require()` /
    // `module.exports` that would crash at run time in an ES module.
    let transformed = transform_program(
        &allocator,
        &path,
        &mut program,
        source,
        resolved_compiler_options,
        Some(Module::Esm),
        false,
        helper_module_name.as_deref(),
        None,
    )?;
    tracing::debug!("loaded {} format: module", url);
    Ok(Some(LoadFnOutput {
        format: "module".to_owned(),
        source: Some(Either4::B(Uint8Array::from_string(code_with_inline_map(transformed)))),
        response_url: Some(url.to_owned()),
    }))
}

/// A `.cts` file is CommonJS by contract and never flips, but one with ES module syntax
/// is rejected here with the same error the source-bearing and `require()` paths report
/// (see [`cts_module_syntax_error`]), instead of reaching Node.js' CommonJS machinery,
/// which fails on it differently per path. Anything else falls through untouched — a
/// file that does not parse included, so the CommonJS path reports its own error.
fn reject_cts_module_syntax(
    path: &Path,
    source: Option<&str>,
    resolved_compiler_options: Option<&CompilerOptions>,
) -> Result<Option<LoadFnOutput>> {
    let bytes;
    let source = match source {
        Some(source) => source,
        None => {
            let Ok(file) = std::fs::read(path) else { return Ok(None) };
            bytes = file;
            let Ok(source) = simdutf8::basic::from_utf8(&bytes) else { return Ok(None) };
            source
        }
    };
    let source = strip_bom(source);
    // Only the transform knows which `import`/`export` declarations are type-only, so a
    // file with any declaration runs through it — the same options the `require()` path
    // uses — and only its verdict is kept.
    let Ok(source_type) = SourceType::from_path(path) else { return Ok(None) };
    let allocator = Allocator::default();
    let ParserReturn { mut program, diagnostics, .. } =
        Parser::new(&allocator, source, source_type).parse();
    if !diagnostics.is_empty() {
        if cts_uses_import_meta(source, source_type) {
            return Err(cts_module_syntax_error(path));
        }
        return Ok(None);
    }
    if !has_module_declaration(&program) {
        return Ok(None);
    }
    // Any other error is the `require()` path's to report, with its own helper names.
    let _ = transform_program(
        &allocator,
        path,
        &mut program,
        source,
        resolved_compiler_options,
        Some(Module::CommonJS),
        true,
        None,
        None,
    );
    if has_cts_module_declaration(&program) { Err(cts_module_syntax_error(path)) } else { Ok(None) }
}

/// The generated code with its source map appended as a data URL, if one was produced.
fn code_with_inline_map(output: Output) -> String {
    match output.map {
        Some(sm) => {
            let sm = sm.to_data_url();
            const SOURCEMAP_PREFIX: &str = "\n//# sourceMappingURL=";
            let len = sm.len() + output.code.len() + 22;
            let mut output_code = String::with_capacity(len);
            output_code.push_str(&output.code);
            output_code.push_str(SOURCEMAP_PREFIX);
            output_code.push_str(sm.as_str());
            output_code
        }
        None => output.code,
    }
}

/// Whether a `commonjs` result's source is the URL's file byte for byte — what the
/// synchronous default load hands over, as opposed to source another hook produced.
/// Anything without a matching `file:` target is not the file's contents.
fn source_matches_file(url: &str, source: &Either4<String, Uint8Array, Buffer, Null>) -> bool {
    let bytes: &[u8] = match source {
        Either4::A(s) => s.as_bytes(),
        Either4::B(arr) => arr,
        Either4::C(buf) => buf,
        Either4::D(_) => return false,
    };
    let Some(path) = file_url_to_path(url_path(url)) else { return false };
    std::fs::read(path).is_ok_and(|file| file == bytes)
}

fn transform_output(
    url: String,
    output: LoadFnOutput,
    resolved_compiler_options: Option<&CompilerOptions>,
    helper_module_name: Option<String>,
) -> Result<LoadFnOutput> {
    match &output.source {
        Some(Either4::D(_)) | None => {
            if let Some(loaded) = load_commonjs_esm(
                &url,
                &output,
                None,
                resolved_compiler_options,
                helper_module_name,
            )? {
                return Ok(loaded);
            }
            tracing::debug!("No source code to transform {}", url);
            // The `null` Node.js handed over is handed back as-is: its `addon`
            // translator asserts `source === null`, and an `undefined` fails it.
            Ok(LoadFnOutput {
                format: output.format,
                source: Some(Either4::D(Null)),
                response_url: Some(url),
            })
        }
        Some(Either4::A(_) | Either4::B(_) | Either4::C(_)) => {
            // `url` is a URL, so a `?query` or `#fragment` has to be stripped before it can
            // be treated as a path, and the separators are always forward slashes.
            let src_path = Path::new(url_path(&url));
            let ext = src_path.extension().and_then(|ext| ext.to_str());
            let is_json = ext.is_some_and(|ext| ext.eq_ignore_ascii_case("json"));

            // The synchronous default load behind `module.registerHooks()` reads a
            // CommonJS module and hands its source over — the file itself, byte for byte.
            // Transforming it would be work the `pirates` hook then repeats when the
            // CommonJS machinery reads the file, so such a result defers exactly as a
            // source-less one does (issue #820). The ESM-syntax check runs on the source
            // in hand first, so a file that flips to an ES module is never read from
            // disk; only a file that stays CommonJS is read, once, to tell the file's
            // own source — which may defer — from another hook's source, which never
            // does. A differing source that stays CommonJS parses twice — once for the
            // syntax check and again in `oxc_transform` — the price of checking before
            // the byte compare. A differing source — or one whose URL has no file at
            // all, such as `data:` or a custom scheme — is another hook's code, and it
            // falls through to be transformed and kept: the CommonJS machinery would
            // either re-read disk content the hook did not produce or fail on a path
            // that does not exist. A differing source that is an ES module still
            // flips: `load_commonjs_esm` transforms it with `Module::Esm`, which the
            // normal path selects for a flip too (and emits identically to `Preserve`
            // for module input), so the result matches the source-less
            // `module.register()` path.
            if !is_json
                && output.format == "commonjs"
                && let Ok(source) = output.source.as_ref().unwrap().try_as_str()
            {
                // `.cts` compares before the syntax check: that check rejects module
                // syntax instead of flipping, so running it on another hook's source
                // would report the `.cts` verdict where the transform below reports
                // its own error, as it did before the check ran on source in hand.
                // Only the file's own bytes reach the rejection check.
                let cts = ext.is_some_and(|ext| ext == "cts");
                let mut source_is_file =
                    cts && source_matches_file(&url, output.source.as_ref().unwrap());
                if !cts || source_is_file {
                    if let Some(loaded) = load_commonjs_esm(
                        &url,
                        &output,
                        Some(source),
                        resolved_compiler_options,
                        helper_module_name.clone(),
                    )? {
                        return Ok(loaded);
                    }
                    if !cts {
                        source_is_file = source_matches_file(&url, output.source.as_ref().unwrap());
                    }
                }
                if source_is_file {
                    tracing::debug!(
                        "Source is the file itself, deferring to the CommonJS loader {}",
                        url
                    );
                    return Ok(LoadFnOutput {
                        format: output.format,
                        source: Some(Either4::D(Null)),
                        response_url: Some(url),
                    });
                }
            }

            // A CommonJS result whose source is not valid UTF-8 is not source code this
            // loader can transform: a `.node` addon resolves as `commonjs` and arrives as
            // a binary, and a legacy CommonJS file may be latin-1. Node.js' asynchronous
            // default load never handed those over — it returns no source for `commonjs`
            // and lets the CommonJS machinery read the file — but the synchronous
            // `defaultLoadSync` behind `module.registerHooks()` always reads it. Drop the
            // bytes and defer the same way instead of failing to decode them.
            // `commonjs-typescript` is not deferred: Node.js' type-stripping translator
            // needs the source, and handing it `null` is an invalid return shape.
            if !is_json
                && output.format == "commonjs"
                && output.source.as_ref().unwrap().try_as_str().is_err()
            {
                tracing::debug!("Not UTF-8, deferring to the CommonJS loader {}", url);
                return Ok(LoadFnOutput {
                    format: output.format,
                    source: Some(Either4::D(Null)),
                    response_url: Some(url),
                });
            }

            // Turning JSON into a module is not a code transform, so it happens for
            // dependencies too — the dependency mode decides whether their *source* is
            // transpiled, and skipping this would hand Node.js raw JSON to run as an ES
            // module.
            if !is_json && url.contains("/node_modules/") && !deps_mode().transforms(ext) {
                tracing::debug!("Skip transforming node_modules {}", url);
                return Ok(output);
            }

            if is_json {
                let source = output.source.as_ref().unwrap().to_source()?;
                let source_str = &*source;
                let json: serde_json::Value = serde_json::from_str(source_str)?;
                if let serde_json::Value::Object(obj) = json {
                    let obj_len = obj.len();
                    let mut source = String::with_capacity(obj_len * 24 + source_str.len() * 2);
                    source.push_str("const json = ");
                    source.push_str(source_str);
                    source.push('\n');
                    source.push_str("export default json\n");
                    for key in obj.keys() {
                        if !oxc::syntax::keyword::is_reserved_keyword(key)
                            && oxc::syntax::identifier::is_identifier_name(key)
                        {
                            source.push_str(&format!("export const {key} = json.{key};\n"));
                        }
                    }
                    tracing::debug!("loaded {} format: module", url);
                    return Ok(LoadFnOutput {
                        format: "module".to_owned(),
                        source: Some(Either4::A(source)),
                        response_url: Some(url),
                    });
                }
                // An array or scalar has no keys to turn into named exports. Keep it an ES
                // module instead of wrapping it in `module.exports`: `commonjs` output is
                // cached by filename, so `./data.json?v=1` and `./data.json?v=2` would
                // collapse into one shared module instead of staying one module per URL.
                tracing::debug!("loaded {} format: module", url);
                return Ok(LoadFnOutput {
                    format: "module".to_owned(),
                    source: Some(Either4::A(format!("export default {source_str}"))),
                    response_url: Some(url),
                });
            }

            // `module-typescript` — Node.js' own format for a `.ts` file it strips types
            // from and runs as an ES module — is one too: a `commonjs` decision here
            // would parse it in script mode and enable the top-level-await rewrite for
            // code Node.js runs as a module.
            let is_es_module = matches!(output.format.as_str(), "module" | "module-typescript");
            let (transform_output, flipped_to_module) = oxc_transform(
                src_path,
                output.source.as_ref().unwrap(),
                resolved_compiler_options,
                Some(Module::Preserve),
                !is_es_module,
                is_es_module,
                helper_module_name.as_deref(),
                None,
            )?;
            // A CommonJS-reported file that turned out to be an ES module is handed back
            // as one, so Node.js never tries to compile its `import`/`export` as CommonJS.
            // Node.js' own type-stripping formats need the same treatment: they only
            // reach here when the resolve hook deferred to Node.js' answer — an import
            // attribute, or a specifier oxc's resolver could not resolve — and the
            // transformed output is plain JavaScript, not the TypeScript those formats
            // announce. Reported back as-is, `module-typescript` re-runs Node.js'
            // stripping translator, which refuses `node_modules` outright with
            // `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
            let format = output.format;
            let format = if flipped_to_module || format == "module-typescript" {
                "module".to_owned()
            } else if format == "commonjs-typescript" {
                "commonjs".to_owned()
            } else {
                format
            };
            let output_code = code_with_inline_map(transform_output);
            tracing::debug!("loaded {} format: {}", url, format);
            Ok(LoadFnOutput {
                format,
                source: Some(Either4::B(Uint8Array::from_string(output_code))),
                response_url: Some(url),
            })
        }
    }
}

trait TryAsStr {
    /// The source as UTF-8, or an error if it is not. For telling source code from
    /// bytes that are not source at all (a `.node` addon reported as `commonjs`).
    fn try_as_str(&self) -> Result<&str>;

    /// The source as text to transform, decoded the way Node.js decodes a module:
    /// UTF-8 with every invalid byte sequence replaced by U+FFFD (issue #843).
    fn to_source(&self) -> Result<Cow<'_, str>>;
}

/// The source without a leading byte order mark. A hashbang is only one at the
/// very start of the source, and the parser takes a BOM for whitespace, so a
/// `#!` after it fails to parse. Node.js drops the mark before compiling, in its
/// CommonJS loader (`stripBOM`) and its ES module loader (`TextDecoder`), and
/// so do oxc's own linter and formatter (issue #846).
fn strip_bom(source: &str) -> &str {
    source.strip_prefix('\u{FEFF}').unwrap_or(source)
}

/// Decode source bytes as Node.js does, borrowing them when they are valid UTF-8.
fn decode_source(bytes: &[u8]) -> Cow<'_, str> {
    match simdutf8::basic::from_utf8(bytes) {
        Ok(source) => Cow::Borrowed(source),
        Err(_) => String::from_utf8_lossy(bytes),
    }
}

impl TryAsStr for Either<String, &[u8]> {
    fn try_as_str(&self) -> Result<&str> {
        match self {
            Either::A(s) => Ok(s),
            Either::B(b) => simdutf8::compat::from_utf8(b).map_err(|err| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to convert &[u8] to &str: {err}"),
                )
            }),
        }
    }

    fn to_source(&self) -> Result<Cow<'_, str>> {
        Ok(match self {
            Either::A(s) => Cow::Borrowed(s.as_str()),
            Either::B(b) => decode_source(b),
        })
    }
}

// Only `TransformTask::compute` feeds `Either3` to `oxc_transform`, so this is
// dead code — and would pull in `Uint8Array`/`Buffer` for nothing — without the
// napi-gated async surface.
#[cfg(feature = "napi")]
impl TryAsStr for Either3<String, Uint8Array, Buffer> {
    fn try_as_str(&self) -> Result<&str> {
        match self {
            Either3::A(s) => Ok(s),
            Either3::B(arr) => simdutf8::compat::from_utf8(arr).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Uint8Array to Vec<u8>")
            }),
            Either3::C(buf) => simdutf8::compat::from_utf8(buf).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Buffer to Vec<u8>")
            }),
        }
    }

    fn to_source(&self) -> Result<Cow<'_, str>> {
        Ok(match self {
            Either3::A(s) => Cow::Borrowed(s.as_str()),
            Either3::B(arr) => decode_source(arr),
            Either3::C(buf) => decode_source(buf),
        })
    }
}

impl TryAsStr for Either4<String, Uint8Array, Buffer, Null> {
    fn try_as_str(&self) -> Result<&str> {
        match self {
            Either4::A(s) => Ok(s),
            Either4::B(arr) => simdutf8::compat::from_utf8(arr).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Uint8Array to Vec<u8>")
            }),
            Either4::C(buf) => simdutf8::compat::from_utf8(buf).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Buffer to Vec<u8>")
            }),
            Either4::D(_) => {
                Err(Error::new(Status::InvalidArg, "Invalid value type in LoadFnOutput::source"))
            }
        }
    }

    fn to_source(&self) -> Result<Cow<'_, str>> {
        match self {
            Either4::A(s) => Ok(Cow::Borrowed(s.as_str())),
            Either4::B(arr) => Ok(decode_source(arr)),
            Either4::C(buf) => Ok(decode_source(buf)),
            Either4::D(_) => {
                Err(Error::new(Status::InvalidArg, "Invalid value type in LoadFnOutput::source"))
            }
        }
    }
}

/// A tsconfig load failure, naming the file. oxc_resolver's own message for a parse
/// error is its `Debug` output, struct syntax included.
fn describe_tsconfig_error(err: &ResolveError) -> String {
    match err {
        ResolveError::TsconfigLoadFailed { path, source } => match source.as_ref() {
            ResolveError::Json(json) if json.path == *path => {
                format!("failed to read the tsconfig {}: {}", shown(path), json.message)
            }
            source => format!(
                "failed to read the tsconfig {}: {}",
                shown(path),
                describe_tsconfig_error(source)
            ),
        },
        ResolveError::Json(json) => {
            format!("failed to read the tsconfig {}: {}", shown(&json.path), json.message)
        }
        // A missing `extends` or `references` target; the explicitly named file is
        // checked before the resolver ever loads it.
        ResolveError::TsconfigNotFound(path) => {
            format!(
                "the tsconfig {}, which a tsconfig extends or references, does not exist",
                shown(path)
            )
        }
        ResolveError::IOError(err) => err.to_string(),
        err => format!("failed to read a tsconfig: {err}"),
    }
}

/// `path` as a warning shows it. On Windows the resolver meets the same file
/// spelled with `/` and with `\\` (from a file URL and from the transform API),
/// and both must name it the same way, or one config is reported twice.
fn shown(path: &Path) -> String {
    let shown = path.display().to_string();
    if cfg!(windows) { shown.replace('/', "\\") } else { shown }
}

/// Whether `err` is a tsconfig that exists but could not be read, which
/// discovery skips to keep walking up rather than treating as "no config".
fn is_io_failure(err: &ResolveError) -> bool {
    matches!(err, ResolveError::TsconfigLoadFailed { source, .. }
        if matches!(source.as_ref(), ResolveError::IOError(_)))
}

/// Whether discovery would load `candidate`. The resolver takes a failed
/// metadata lookup, such as a symlink into a directory that may not be
/// searched, for "not a file" and walks on; that is a skipped config too, so
/// it is reported. Every ancestor of a file that was reached is searchable, so
/// only such an indirection can fail.
/// wasi-libc's `ENOTCAPABLE`.
const WASI_ENOTCAPABLE: i32 = 76;

fn is_tsconfig_file(candidate: &Path) -> bool {
    match fs::metadata(candidate) {
        Ok(metadata) => metadata.is_file(),
        // A symlink to nothing is a config entry that cannot be read, often
        // left behind by a removed worktree.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if fs::symlink_metadata(candidate).is_ok_and(|m| m.file_type().is_symlink()) {
                warn_once(format!(
                    "the tsconfig {} is a symlink to a file that does not exist; skipping it",
                    shown(candidate)
                ));
            }
            false
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotADirectory => false,
        // What WASI reports for a path outside every preopened directory; the
        // browser build preopens none, so it means no filesystem, not a config.
        Err(err)
            if cfg!(target_family = "wasm") && err.raw_os_error() == Some(WASI_ENOTCAPABLE) =>
        {
            false
        }
        // Only an entry that is there was skipped: under a directory that may
        // not be searched, the lookup fails whether or not the file exists.
        Err(err) => {
            if fs::symlink_metadata(candidate).is_ok() {
                warn_unreadable(&ResolveError::TsconfigLoadFailed {
                    path: candidate.to_path_buf(),
                    source: Box::new(ResolveError::from(err)),
                });
            }
            false
        }
    }
}

fn warn_unreadable(err: &ResolveError) {
    warn_once(format!("{}; skipping it", describe_tsconfig_error(err)));
}

/// Print a warning to stderr, once per process for each distinct message.
fn warn_once(message: String) {
    use std::io::Write as _;

    static WARNED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut warned = WARNED.lock().unwrap_or_else(PoisonError::into_inner);
    if !warned.contains(&message) {
        // A closed stderr must not turn a diagnostic into a failure, as
        // `eprintln!` would by panicking.
        let _ = writeln!(std::io::stderr(), "oxc-node: warning: {message}");
        warned.push(message);
    }
}

/// Read an environment variable, treating an empty value as unset.
///
/// Continuous integration wrappers and `.env` files routinely export variables
/// with an empty value. Without this, an empty `TS_NODE_PROJECT` counts as set,
/// shadows a perfectly good `OXC_TSCONFIG_PATH`, and leaves the loader context with no
/// tsconfig at all.
fn non_empty_env(name: &str) -> Option<String> {
    loader_env(name).filter(|value| !value.is_empty())
}

/// The module format that `.ts` / `.tsx` files should default to, derived from
/// `compilerOptions.module`.
///
/// Node cannot tell from a `.ts` extension alone whether a file is ESM or
/// CommonJS. When the tsconfig that owns the file asks for an ES module output,
/// say so explicitly; otherwise fall back to the resolver's own `package.json`
/// `type` detection.
fn default_module_from_tsconfig(tsconfig: Option<&TsConfig>) -> Option<&'static str> {
    let module = tsconfig?.compiler_options.module.as_deref()?.to_ascii_lowercase();
    matches!(
        module.as_str(),
        "nodenext" | "node16" | "node18" | "es6" | "es2015" | "es2020" | "es2022" | "esnext"
    )
    .then_some("module")
}

/// An explicitly named tsconfig path, made absolute against `cwd`.
fn absolute_tsconfig_path(cwd: &Path, tsconfig: PathBuf) -> PathBuf {
    // `starts_with('/')` would misjudge `C:\\...` on Windows.
    if tsconfig.is_absolute() { tsconfig } else { cwd.join(tsconfig) }
}

/// Select once for this context, before either its main thread or an asynchronous
/// hook thread starts resolving files. Keep the source label for diagnostics.
fn select_tsconfig(cwd: PathBuf) -> Option<(PathBuf, &'static str)> {
    let context = loader_context();
    let mut tsconfig_override =
        context.tsconfig_override.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((_, selected)) = &tsconfig_override.consumed {
        return selected.clone();
    }
    tracing::debug!(api_tsconfig = ?tsconfig_override.path);
    let explicit_tsconfig =
        tsconfig_override.path.clone().map(|path| (path, tsconfig_override.source)).or_else(|| {
            if !tsconfig_override.use_process_env {
                return None;
            }
            let oxc_tsconfig = non_empty_env("OXC_TSCONFIG_PATH");
            let explicit_tsconfig = non_empty_env("TS_NODE_PROJECT")
                .map(|path| {
                    // `oxnode watch --tsconfig` sets both, so an env file cannot
                    // override it (issue #876); warnings name the one it means.
                    let source = if oxc_tsconfig.as_deref() == Some(path.as_str()) {
                        "OXC_TSCONFIG_PATH"
                    } else {
                        "TS_NODE_PROJECT"
                    };
                    (path, source)
                })
                .or_else(|| oxc_tsconfig.map(|path| (path, "OXC_TSCONFIG_PATH")));
            tracing::debug!(explicit_tsconfig = ?explicit_tsconfig);
            explicit_tsconfig.map(|(path, source)| (PathBuf::from(path), source))
        });
    let selected = explicit_tsconfig
        .map(|(tsconfig, source)| (absolute_tsconfig_path(&cwd, tsconfig), source));
    tsconfig_override.consumed = Some((cwd, selected.clone()));
    selected
}

fn init_resolver(cwd: PathBuf) -> (Resolver, TsconfigSource) {
    // Registration can freeze this choice before the first resolve. Parsing and
    // diagnostics still wait for the first thread that actually uses a resolver.
    let explicit_tsconfig_path = select_tsconfig(cwd);
    tracing::debug!(explicit_tsconfig_path = ?explicit_tsconfig_path);

    // The dependency mode is fixed by the same first transform or resolve, so
    // a later `setTransformDeps` call can never silently change behaviour. A
    // mode already frozen at `register()` stays frozen: env changes between
    // registration and now must not move the deadline back.
    let context = loader_context();
    let mut deps = context.transform_deps.lock().unwrap_or_else(PoisonError::into_inner);
    if deps.consumed.is_none() {
        deps.consumed = Some(deps.mode.unwrap_or_else(deps_mode_from_env));
    }

    // `Err` when the path cannot even be checked, such as a parent directory
    // that may not be searched: the file may exist, but it cannot be read.
    let explicit_exists = explicit_tsconfig_path.as_ref().map(|(path, _)| fs::exists(path));
    let tsconfig = match (&explicit_tsconfig_path, &explicit_exists) {
        // Pointing `Manual` at a file that does not exist would make *every*
        // `resolve()` call fail, so disable tsconfig handling instead. Falling
        // back to `Auto` is not an option: an explicit request for a missing
        // config must not quietly pick up a different one.
        (Some((path, _)), Some(Ok(true))) => Some(TsconfigDiscovery::Manual(TsconfigOptions {
            config_file: path.clone(),
            references: TsconfigReferences::Auto,
        })),
        // Silently running without a config left an unrelated `ERR_MODULE_NOT_FOUND`
        // for a `paths` alias as the first sign — typically a `TS_NODE_PROJECT` left
        // over from ts-node (issue #844).
        (Some((path, source)), Some(Err(err))) => {
            warn_once(format!(
                "failed to read the tsconfig {source} names, {}: {err}; running without a tsconfig",
                shown(path)
            ));
            None
        }
        (Some((path, source)), _) => {
            warn_once(format!(
                "the tsconfig {source} names, {}, does not exist; running without a tsconfig",
                shown(path)
            ));
            None
        }
        // Nothing was requested: let the resolver find, per file, the nearest
        // `tsconfig.json` that actually claims it.
        (None, _) => Some(TsconfigDiscovery::Auto),
    };

    let mut resolver = Resolver::new(ResolveOptions {
        tsconfig,
        extension_alias: vec![
            (".js".to_owned(), vec![".js".to_owned(), ".ts".to_owned(), ".tsx".to_owned()]),
            (".mjs".to_owned(), vec![".mjs".to_owned(), ".mts".to_owned()]),
            (".cjs".to_owned(), vec![".cjs".to_owned(), ".cts".to_owned()]),
        ],
        enforce_extension: EnforceExtension::Auto,
        extensions: vec![
            ".js".to_owned(),
            ".mjs".to_owned(),
            ".cjs".to_owned(),
            ".ts".to_owned(),
            ".tsx".to_owned(),
            ".mts".to_owned(),
            ".cts".to_owned(),
            ".json".to_owned(),
            ".wasm".to_owned(),
            ".node".to_owned(),
        ],
        module_type: true,
        ..Default::default()
    });

    let tsconfig_source = match explicit_tsconfig_path {
        Some((path, _)) => TsconfigSource::Manual(match resolver.resolve_tsconfig(&path) {
            Ok(tsconfig) => Some(tsconfig),
            Err(err) => {
                // A missing or uncheckable file was reported above, with what
                // named it.
                if matches!(explicit_exists, Some(Ok(true))) {
                    warn_once(format!(
                        "{}; running without a tsconfig",
                        describe_tsconfig_error(&err)
                    ));
                }
                // `Resolver::resolve` loads the manual config on every call, so
                // keeping it would fail every resolution rather than run without
                // it.
                resolver = resolver.clone_with_options(ResolveOptions {
                    tsconfig: None,
                    ..resolver.options().clone()
                });
                None
            }
        }),
        None => TsconfigSource::Auto,
    };

    (resolver, tsconfig_source)
}

/// Whether `program` contains a decorator that survives type stripping.
///
/// oxc lowers only legacy (`experimentalDecorators`) decorators; without that option it
/// emits them untouched, and no Node.js release parses decorator syntax, so the file
/// would fail at the `@` with a bare `SyntaxError: Invalid or unexpected token`. Finding
/// one lets the transform say what to change instead. A decorator cannot be written
/// without an `@`, so most files are ruled out by one `memchr` pass and never walked.
///
/// Ambient declarations (`declare class`, and anything inside `declare namespace`,
/// `declare module "x"` or `declare global`) are erased whole, decorators included, and
/// `tsc` accepts decorators there without `experimentalDecorators`, so they are skipped.
fn has_decorator(program: &Program<'_>, source: &str) -> bool {
    struct DecoratorFinder(bool);

    impl<'a> Visit<'a> for DecoratorFinder {
        fn visit_decorator(&mut self, _decorator: &Decorator<'a>) {
            self.0 = true;
        }

        fn visit_class(&mut self, class: &Class<'a>) {
            if !class.declare {
                walk::walk_class(self, class);
            }
        }

        fn visit_ts_namespace_declaration(&mut self, namespace: &TSNamespaceDeclaration<'a>) {
            if !namespace.declare {
                walk::walk_ts_namespace_declaration(self, namespace);
            }
        }

        // `module "x" {}` and `global {}` are only valid in an ambient context, so they
        // are erased whether or not they carry `declare` themselves.
        fn visit_ts_external_module_declaration(
            &mut self,
            _module: &TSExternalModuleDeclaration<'a>,
        ) {
        }

        fn visit_ts_global_declaration(&mut self, _global: &TSGlobalDeclaration<'a>) {}
    }

    // A declaration file is ambient throughout, `declare` or not, and emits nothing.
    if program.source_type.is_typescript_definition()
        || memchr::memchr(b'@', source.as_bytes()).is_none()
    {
        return false;
    }
    let mut finder = DecoratorFinder(false);
    finder.visit_program(program);
    finder.0
}

/// Render each diagnostic as a colorless report with its location — a
/// `path:line:column` header and the offending lines — the way esbuild, tsc
/// and Node.js' type stripping point at a syntax error. `Display` on the
/// diagnostic prints only the message, which in a large file leaves no way to
/// find the error (issue #839). Messages are not wrapped, so each stays on one
/// line that a search for it still finds.
///
/// The code frame prints every line it shows whole, so a frame that is too large
/// — a minified or generated file — is left out and the report names its
/// location instead of copying megabytes of source into the error.
fn join_errors(errors: Vec<OxcDiagnostic>, source: &str, path: &Path) -> String {
    // The load hook hands over a `file:` URL; the report names the file the way an
    // editor or terminal can open it.
    let name = path.to_str().and_then(file_url_to_path).unwrap_or_else(|| path.to_path_buf());
    let name = name.to_string_lossy();
    let handler = GraphicalReportHandler::new_themed(GraphicalTheme::none())
        .with_width(usize::MAX)
        .with_links(false);
    errors
        .into_iter()
        .map(|mut err| {
            let mut rendered = String::new();
            // Writing into a `String` cannot fail.
            if let Some(long) = err.labels.iter().find(|label| {
                let span = label.span();
                frame_too_large(source, span.start as usize, span.end as usize)
            }) {
                let (line, column) = line_column(source, long.offset() as usize);
                err.labels.clear();
                let _ = handler.render_report(&mut rendered, &err);
                rendered.truncate(rendered.trim_end().len());
                rendered.push_str(&format!(
                    "\n  at {name}:{line}:{column} (the line is too long to show)"
                ));
            } else {
                let report = err.with_source_code(NamedSource::new(&name, source.to_owned()));
                let _ = handler.render_report(&mut rendered, report.as_ref());
            }
            rendered.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The longest source line a code frame shows.
const MAX_FRAME_LINE_BYTES: usize = 1000;

/// The most source, in bytes, a code frame shows.
const MAX_FRAME_BYTES: usize = 10_000;

/// The lines a code frame shows on each side of a label (oxc's default).
const FRAME_CONTEXT_LINES: usize = 1;

/// Whether the code frame for `start..end` — the whole lines the span touches
/// and [`FRAME_CONTEXT_LINES`] on each side — is too large to print.
fn frame_too_large(source: &str, start: usize, end: usize) -> bool {
    let bytes = source.as_bytes();
    let start = start.min(bytes.len());
    let end = end.clamp(start, bytes.len());
    let mut first = memchr::memrchr(b'\n', &bytes[..start]).map_or(0, |index| index + 1);
    let mut last = memchr::memchr(b'\n', &bytes[end..]).map_or(bytes.len(), |index| end + index);
    for _ in 0..FRAME_CONTEXT_LINES {
        if first > 0 {
            first = memchr::memrchr(b'\n', &bytes[..first - 1]).map_or(0, |index| index + 1);
        }
        if last < bytes.len() {
            last = memchr::memchr(b'\n', &bytes[last + 1..])
                .map_or(bytes.len(), |index| last + 1 + index);
        }
    }
    let frame = &bytes[first..last];
    let mut line_start = 0;
    frame.len() > MAX_FRAME_BYTES
        || memchr::memchr_iter(b'\n', frame).chain([frame.len()]).any(|line_end| {
            let long = line_end - line_start > MAX_FRAME_LINE_BYTES;
            line_start = line_end + 1;
            long
        })
}

/// The one-based line and column (in characters) of a byte offset, as the code
/// frame header counts them.
fn line_column(source: &str, offset: usize) -> (usize, usize) {
    let before = source.get(..offset.min(source.len())).unwrap_or(source);
    let line_start = memchr::memrchr(b'\n', before.as_bytes()).map_or(0, |index| index + 1);
    (
        memchr::memchr_iter(b'\n', before.as_bytes()).count() + 1,
        before[line_start..].chars().count() + 1,
    )
}

#[allow(clippy::type_complexity)]
fn add_short_circuit<'env>(
    specifier: String,
    format: Option<&'static str>,
    context: ResolveContext,
    next_resolve: Function<
        'env,
        FnArgs<(String, Option<ResolveContext>)>,
        Either<ResolveFnOutput, PromiseRaw<'env, ResolveFnOutput>>,
    >,
) -> Result<Either<ResolveFnOutput, PromiseRaw<'env, ResolveFnOutput>>> {
    let builtin_resolved = next_resolve.call((specifier, Some(context)).into())?;

    match builtin_resolved {
        Either::A(mut output) => {
            output.short_circuit = Some(true);
            if let Some(format) = format {
                output.format = Some(Either::A(format.to_owned()));
            }
            Ok(Either::A(output))
        }
        Either::B(promise) => promise
            .then(move |mut ctx| {
                ctx.value.short_circuit = Some(true);
                if let Some(format) = format {
                    ctx.value.format = Some(Either::A(format.to_owned()));
                }
                Ok(ctx.value)
            })
            .map(Either::B),
    }
}

/// Applies [`typescript_dep_format`] to a resolve result, synchronously or
/// once the promise settles.
fn fixup_typescript_dep_format<'env>(
    resolved: Either<ResolveFnOutput, PromiseRaw<'env, ResolveFnOutput>>,
) -> Result<Either<ResolveFnOutput, PromiseRaw<'env, ResolveFnOutput>>> {
    match resolved {
        Either::A(mut output) => {
            typescript_dep_format(&mut output);
            Ok(Either::A(output))
        }
        Either::B(promise) => promise
            .then(move |mut ctx| {
                typescript_dep_format(&mut ctx.value);
                Ok(ctx.value)
            })
            .map(Either::B),
    }
}

/// Rewrites Node.js' own `module-typescript` / `commonjs-typescript` answer
/// into the plain format the already-transformed output has — but only for a
/// `node_modules` file this process transforms. Left in place, those formats
/// send the file back to Node.js' type-stripping translator, which refuses
/// `node_modules` with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` before
/// `load` gets a say.
fn typescript_dep_format(output: &mut ResolveFnOutput) {
    let Some(Either::A(format)) = &output.format else { return };
    let plain = match format.as_str() {
        "module-typescript" => "module",
        "commonjs-typescript" => "commonjs",
        _ => return,
    };
    let Some(path) = file_url_to_path(url_path(&output.url)) else { return };
    if !path.to_str().is_some_and(|p| p.contains(NODE_MODULES_PATH)) {
        return;
    }
    if !deps_mode().transforms(path.extension().and_then(|ext| ext.to_str())) {
        return;
    }
    output.format = Some(Either::A(plain.to_owned()));
}

/// The path part of a URL or specifier, i.e. everything before a `?query` or `#fragment`.
///
/// Extensions must be matched against this and not against the whole string: oxc-node
/// supports `import "./mod.ts?v=1"`, and `Path::extension()` on the full URL would report
/// `ts?v=1`.
fn url_path(url: &str) -> &str {
    let end = memchr::memchr2(b'?', b'#', url.as_bytes()).unwrap_or(url.len());
    &url[..end]
}

/// The `file:` URL for a resolution: the percent-encoded path, then the
/// query and fragment verbatim — they are module identity (`./mod.ts?v=1`),
/// not file-name characters, and encoding them would name another file.
/// Both already carry their leading `?` / `#`.
fn oxc_resolved_path_to_url(resolution: &Resolution) -> String {
    file_url_with_suffix(
        &resolution.path().to_string_lossy(),
        resolution.query(),
        resolution.fragment(),
    )
}

fn file_url_with_suffix(path: &str, query: Option<&str>, fragment: Option<&str>) -> String {
    let mut url = path_to_file_url(path);
    url.push_str(query.unwrap_or_default());
    url.push_str(fragment.unwrap_or_default());
    url
}

#[cfg(not(windows))]
fn path_to_file_url(path: &str) -> String {
    format!("{PATH_PREFIX}{}", encode_file_url_path(path))
}

#[cfg(windows)]
fn path_to_file_url(path: &str) -> String {
    windows_file_url::path_to_url(path)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    // The compare form must keep `pathToFileURL`'s encode set exactly.
    #[test]
    fn file_url_encoded_is_the_path_to_file_url_set() {
        for byte in 0..=u8::MAX {
            let expected = matches!(byte,
                0x00..=0x20 | b'"' | b'#' | b'%' | b'<' | b'>' | b'?' | b'[' | b'\\' | b']'
                    | b'^' | b'`' | b'{' | b'|' | b'}' | b'~' | 0x7f..);
            assert_eq!(file_url_encoded(byte), expected, "{byte:#04x}");
        }
    }

    // Every length around the 16-byte chunks, with the one hit at every place.
    #[test]
    fn any_byte_is_iterator_any() {
        for len in 0..=40 {
            let clean = vec![b'a'; len];
            assert!(!any_byte(&clean, |b| b <= b' '), "len {len}");
            for at in 0..len {
                let mut bytes = clean.clone();
                bytes[at] = b' ';
                assert!(any_byte(&bytes, |b| b <= b' '), "len {len}, at {at}");
            }
        }
    }

    // Issue #845: the symlink flags are read as Node.js reads them.
    #[test]
    fn preserve_symlinks_follow_node() {
        let args = |args: &[&str]| args.iter().map(|arg| (*arg).to_string()).collect::<Vec<_>>();
        let parse = |env: Option<&str>, options: Option<&str>, argv: &[&str]| {
            let flags = PreserveSymlinks::parse(env, options, &args(argv));
            (flags.preserve_symlinks, flags.preserve_symlinks_main)
        };
        assert_eq!(parse(None, None, &[]), (false, false));
        assert_eq!(parse(None, None, &["--preserve-symlinks"]), (true, false));
        assert_eq!(parse(None, None, &["--preserve_symlinks_main"]), (false, true));
        // Node.js ignores a value after either form.
        assert_eq!(parse(None, None, &["--preserve-symlinks=false"]), (true, false));
        assert_eq!(parse(None, Some("--preserve-symlinks-main=0"), &[]), (false, true));
        assert_eq!(
            parse(None, None, &["--preserve-symlinks", "--no-preserve-symlinks=true"]),
            (false, false)
        );
        assert_eq!(parse(Some("1"), None, &[]), (true, false));
        assert_eq!(parse(Some("0"), None, &[]), (false, false));
        assert_eq!(parse(None, Some("--import x --preserve-symlinks"), &[]), (true, false));
        // The command line comes after `NODE_OPTIONS`, and the last mention wins.
        assert_eq!(
            parse(None, Some("--preserve-symlinks"), &["--no-preserve-symlinks"]),
            (false, false)
        );
        // A quoted value is one argument, not a flag.
        assert_eq!(parse(None, Some(r#"--title="a --preserve-symlinks""#), &[]), (false, false));
        assert_eq!(
            split_node_options(r#" --a  "b c" --d="e \" f" "#),
            ["--a", "b c", r#"--d=e " f"#]
        );
    }

    // Issue #844: a tsconfig that cannot be used is named in a readable warning,
    // not in oxc_resolver's `Debug` output.
    #[test]
    fn tsconfig_errors_name_the_file() {
        let path = PathBuf::from("tsconfig.json");
        let json = ResolveError::Json(oxc_resolver::JSONError {
            path: path.clone(),
            message: "EOF while parsing an object".to_string(),
            line: 2,
            column: 0,
        });
        let load_failed = |source: ResolveError| ResolveError::TsconfigLoadFailed {
            path: path.clone(),
            source: Box::new(source),
        };
        assert_eq!(
            describe_tsconfig_error(&load_failed(json)),
            "failed to read the tsconfig tsconfig.json: EOF while parsing an object"
        );
        assert_eq!(
            describe_tsconfig_error(&load_failed(ResolveError::TsconfigNotFound(PathBuf::from(
                "base.json"
            )))),
            "failed to read the tsconfig tsconfig.json: the tsconfig base.json, \
             which a tsconfig extends or references, does not exist"
        );
        let unreadable = load_failed(ResolveError::from(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )));
        assert!(is_io_failure(&unreadable));
        assert_eq!(
            describe_tsconfig_error(&unreadable),
            "failed to read the tsconfig tsconfig.json: permission denied"
        );
        assert_eq!(
            describe_tsconfig_error(&ResolveError::TsconfigNotFound(PathBuf::from("base.json"))),
            "the tsconfig base.json, which a tsconfig extends or references, does not exist"
        );
    }

    // Issue #846: a byte order mark is dropped before parsing, so a hashbang
    // after it is still one.
    #[test]
    fn a_bom_before_a_hashbang_parses() {
        let source = "\u{FEFF}#!/usr/bin/env node\nconsole.log(1);\n";
        let allocator = Allocator::default();
        let parse = |source| Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(!parse(source).diagnostics.is_empty(), "the parser itself rejects it");
        let parsed = parse(strip_bom(source));
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        assert_eq!(parsed.program.hashbang.map(|h| h.value.as_str()), Some("/usr/bin/env node"));
        assert_eq!(strip_bom("\u{FEFF}\u{FEFF}x"), "\u{FEFF}x", "only one mark is dropped");
        assert_eq!(strip_bom("x\u{FEFF}"), "x\u{FEFF}");
    }

    // Issue #843: source is decoded as Node.js decodes it, invalid bytes replaced.
    #[test]
    fn source_decodes_invalid_utf8_lossily() {
        assert!(matches!(decode_source(b"const a = 1;"), Cow::Borrowed("const a = 1;")));
        assert_eq!(decode_source(b"\"caf\xe9\""), "\"caf\u{fffd}\"");
        assert_eq!(decode_source(b"x\xff\xfey"), "x\u{fffd}\u{fffd}y");
        // A truncated multi-byte sequence is one replacement, as in `TextDecoder`.
        assert_eq!(decode_source(b"a\xe2\x82"), "a\u{fffd}");
    }

    // Issue #842: top-level await is what `require()` of an ES module rejects.
    #[test]
    fn top_level_await_is_found_outside_functions_only() {
        let found = |source: &str| {
            let allocator = Allocator::default();
            let program = Parser::new(&allocator, source, SourceType::mjs().with_typescript(true))
                .parse()
                .program;
            has_top_level_await(&program)
        };
        assert!(found("await 1;"));
        assert!(found("if (x) { const y = await f(); }"));
        assert!(found("for await (const x of xs) {}"));
        assert!(found("await using r = f();"));
        assert!(!found("async function f() { await 1 }"));
        assert!(!found("const f = async () => { for await (const x of xs) {} };"));
        assert!(!found("class A { async m() { await 1 } }"));
        assert!(!found("export const v = 1;"));
    }

    // Issue #840: outside `node_modules`, TypeScript resolves before JavaScript
    // and `.js` reaches `.jsx`, as tsc resolves.
    #[test]
    fn source_order_tries_typescript_first() {
        let options = source_order(ResolveOptions::default());
        let alias = |ext: &str| {
            options.extension_alias.iter().find(|(from, _)| from == ext).map(|(_, to)| to.clone())
        };
        assert_eq!(alias(".js").unwrap(), [".ts", ".tsx", ".js", ".jsx"]);
        assert_eq!(alias(".jsx").unwrap(), [".tsx", ".ts", ".jsx", ".js"]);
        assert_eq!(alias(".mjs").unwrap(), [".mts", ".mjs"]);
        assert_eq!(alias(".cjs").unwrap(), [".cts", ".cjs"]);
        let position = |ext: &str| options.extensions.iter().position(|e| e == ext).unwrap();
        assert!(position(".ts") < position(".js"));
        assert!(position(".tsx") < position(".js"));
        assert!(position(".js") < position(".jsx"));
    }

    // Issue #878: the entry point and a JavaScript importer get the file they
    // name, and TypeScript only when it is missing.
    #[test]
    fn named_order_tries_the_named_file_first() {
        let options = named_order(ResolveOptions::default());
        let alias = |ext: &str| {
            options.extension_alias.iter().find(|(from, _)| from == ext).map(|(_, to)| to.clone())
        };
        assert_eq!(alias(".js").unwrap(), [".js", ".ts", ".tsx", ".jsx"]);
        assert_eq!(alias(".jsx").unwrap(), [".jsx", ".tsx", ".ts", ".js"]);
        assert_eq!(alias(".mjs").unwrap(), [".mjs", ".mts"]);
        assert_eq!(alias(".cjs").unwrap(), [".cjs", ".cts"]);
        assert_eq!(options.extensions, source_order(ResolveOptions::default()).extensions);
    }

    #[test]
    fn extension_order_follows_the_importer() {
        let root = Path::new("/p");
        let package = root.join("node_modules").join("pkg");
        assert_eq!(extension_order(None, None), ExtensionOrder::Named);
        assert_eq!(extension_order(Some(root), None), ExtensionOrder::Named);
        for name in ["a.js", "a.mjs", "a.cjs", "[eval1]", "noop.js"] {
            let file = root.join(name);
            assert_eq!(extension_order(Some(&file), Some(&file)), ExtensionOrder::Named, "{name}");
        }
        for name in ["a.ts", "a.mts", "a.cts", "a.tsx", "a.jsx"] {
            let file = root.join(name);
            assert_eq!(extension_order(Some(&file), Some(&file)), ExtensionOrder::Source, "{name}");
        }
        let file = package.join("a.ts");
        assert_eq!(extension_order(Some(&file), Some(&file)), ExtensionOrder::Package);
        assert_eq!(extension_order(Some(&package), None), ExtensionOrder::Package);
    }

    // Issue #839: a diagnostic names the file, line and column and shows the
    // offending line, rather than only its message.
    #[test]
    fn diagnostics_render_location_and_code_frame() {
        let source = "const ok = 1;\nconsole.log(ok);\nconst broken: number = ;\n";
        let at = u32::try_from(source.rfind(';').unwrap()).unwrap();
        let errors = vec![
            OxcDiagnostic::error("Unexpected token").with_label(oxc::span::Span::new(at, at + 1)),
        ];
        let rendered = join_errors(errors, source, Path::new("/x/main.ts"));
        assert!(rendered.contains("x Unexpected token"), "{rendered}");
        assert!(rendered.contains("[/x/main.ts:3:24]"), "{rendered}");
        assert!(rendered.contains("3 | const broken: number = ;"), "{rendered}");
        // A minified line is not copied into the error; its location is named.
        let long = format!("const a = [{}];\nconst b: number = ;\n", "1,".repeat(2000));
        let long_at = u32::try_from(long.rfind(';').unwrap()).unwrap();
        let errors = vec![
            OxcDiagnostic::error("Unexpected token")
                .with_label(oxc::span::Span::new(long_at, long_at + 1)),
        ];
        let rendered = join_errors(errors, &long, Path::new("/x/min.ts"));
        assert!(rendered.contains("x Unexpected token"), "{rendered}");
        assert!(
            rendered.contains("at /x/min.ts:2:19 (the line is too long to show)"),
            "{rendered}"
        );
        let errors =
            vec![OxcDiagnostic::error("Unexpected token").with_label(oxc::span::Span::new(12, 13))];
        let rendered = join_errors(errors, &long, Path::new("/x/min.ts"));
        assert!(rendered.contains("at /x/min.ts:1:13 (the line"), "{rendered}");
        assert!(rendered.len() < 200, "{rendered}");
        // A long message is not wrapped.
        let message = "Import assignment cannot be used when targeting ECMAScript modules.";
        let errors =
            vec![OxcDiagnostic::error(message).with_label(oxc::span::Span::new(at, at + 1))];
        assert!(join_errors(errors, source, Path::new("/x/main.ts")).contains(message));
        // A `file:` URL from the load hook is named by its decoded path.
        #[cfg(not(windows))]
        {
            let errors = vec![
                OxcDiagnostic::error("Unexpected token")
                    .with_label(oxc::span::Span::new(at, at + 1)),
            ];
            let rendered = join_errors(errors, source, Path::new("file:///x/a%20b/m%231.ts"));
            assert!(rendered.contains("[/x/a b/m#1.ts:3:24]"), "{rendered}");
        }
    }

    // The Windows `file:` URL matrix lives with the module in
    // windows_file_url.rs; what remains here is the platform behavior this
    // file owns.

    fn parses_with_decorator(source: &str) -> bool {
        parses_with_decorator_as(source, SourceType::ts())
    }

    fn parses_with_decorator_as(source: &str, source_type: SourceType) -> bool {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, source, source_type).parse();
        assert!(ret.diagnostics.is_empty(), "{source:?} should parse");
        has_decorator(&ret.program, source)
    }

    #[test]
    fn has_decorator_finds_every_decorator_position() {
        assert!(parses_with_decorator("@dec class A {}"));
        assert!(parses_with_decorator("export default @dec class {}"));
        assert!(parses_with_decorator("class A { @dec method() {} }"));
        assert!(parses_with_decorator("class A { @dec accessor x = 1; }"));
        assert!(parses_with_decorator("class A { constructor(@inject x: number) {} }"));
        assert!(parses_with_decorator("const A = class { @dec static y = 1; };"));
    }

    #[test]
    fn has_decorator_ignores_an_at_sign_outside_decorators() {
        assert!(!parses_with_decorator("class A {}"));
        assert!(!parses_with_decorator("/** @deprecated */ class A {}"));
        assert!(!parses_with_decorator("const email = \"a@b.c\";"));
        assert!(!parses_with_decorator("const t = `@${1}`; // @ts-ignore"));
    }

    #[test]
    fn has_decorator_skips_ambient_declarations() {
        assert!(!parses_with_decorator("@dec declare class A { @dec x: string }"));
        assert!(!parses_with_decorator("export @dec declare class A {}"));
        assert!(!parses_with_decorator("declare namespace N { @dec class A { @dec x: string } }"));
        assert!(!parses_with_decorator("declare module \"m\" { @dec class A {} }"));
        assert!(!parses_with_decorator("declare global { @dec class A {} }"));
        // Only the ambient part is skipped.
        assert!(parses_with_decorator("@dec declare class A {}\n@dec class B {}"));
        assert!(parses_with_decorator("namespace N { @dec class A {} }"));
        // Everything in a declaration file is ambient, `declare` or not.
        assert!(!parses_with_decorator_as("export @dec class A {}", SourceType::d_ts()));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_behavior_is_unchanged() {
        assert_eq!(file_url_to_path("file:///a/b.ts"), Some(PathBuf::from("/a/b.ts")));
        assert_eq!(file_url_to_path("file:///a%20b.ts"), Some(PathBuf::from("/a b.ts")));
    }

    // Expected strings below are what Node's `pathToFileURL` writes for the
    // same path (issue #837).
    #[test]
    fn file_url_path_encoding_matches_path_to_file_url() {
        assert_eq!(encode_file_url_path("/x/main.ts"), "/x/main.ts");
        assert_eq!(encode_file_url_path("/x/main#hash.ts"), "/x/main%23hash.ts");
        assert_eq!(encode_file_url_path("/x/main%41.ts"), "/x/main%2541.ts");
        assert_eq!(encode_file_url_path("/x/main?q.ts"), "/x/main%3Fq.ts");
        assert_eq!(encode_file_url_path("/x/main space.ts"), "/x/main%20space.ts");
        assert_eq!(encode_file_url_path("/x/é~[]^|"), "/x/%C3%A9%7E%5B%5D%5E%7C");
        assert_eq!(encode_file_url_path("/x/\"\t\u{7f}`{}<>"), "/x/%22%09%7F%60%7B%7D%3C%3E");
        // Sub-delimiters, `:` and `@` stay literal, as Node keeps them.
        assert_eq!(encode_file_url_path("/x/a(1)!$&'*+,;=:@.ts"), "/x/a(1)!$&'*+,;=:@.ts");
    }

    #[test]
    fn resolved_suffix_is_appended_verbatim() {
        // The resolver's query and fragment carry their own `?` / `#`, and
        // must not be encoded or doubled.
        #[cfg(not(windows))]
        let path = "/x/a#b/mod.ts";
        #[cfg(windows)]
        let path = "C:\\x\\a#b\\mod.ts";
        let url = file_url_with_suffix(path, Some("?v=1"), Some("#x"));
        assert!(url.starts_with("file:///"), "{url}");
        assert!(url.ends_with("/x/a%23b/mod.ts?v=1#x"), "{url}");
        assert!(file_url_with_suffix(path, None, None).ends_with("/x/a%23b/mod.ts"));
    }

    #[test]
    fn encoded_separators_are_detected() {
        for pathname in ["./a%2Fb.ts", "./a%2fb.ts", "./a%5Cb.ts", "./a%5cb", "/x/%2F"] {
            assert!(has_encoded_separator(pathname), "{pathname}");
        }
        for pathname in ["./a%23b.ts", "./a%25 2F.ts", "./a%2", "./a%5", "./a/b.ts"] {
            assert!(!has_encoded_separator(pathname), "{pathname}");
        }
    }

    #[test]
    fn frame_too_large_measures_each_line() {
        let fits = "x".repeat(MAX_FRAME_LINE_BYTES);
        let long = "x".repeat(MAX_FRAME_LINE_BYTES + 1);
        // The span is on the middle line, so the frame holds all three; the
        // last one has no trailing newline.
        for (lines, expected) in [
            ([fits.as_str(), "a", fits.as_str()], false),
            ([long.as_str(), "a", "b"], true),
            (["a", long.as_str(), "b"], true),
            (["a", "b", long.as_str()], true),
        ] {
            let source = lines.join("\n");
            let start = lines[0].len() + 1;
            assert_eq!(
                frame_too_large(&source, start, start),
                expected,
                "{:?}",
                lines.map(str::len)
            );
            assert_eq!(frame_too_large(&format!("{source}\n"), start, start), expected);
        }
    }

    #[test]
    fn malformed_escapes_are_detected() {
        for pathname in ["./a%zz.ts", "./a%.ts", "./a%4", "./a%", "./a%41%g1.ts"] {
            assert!(has_malformed_escape(pathname), "{pathname}");
        }
        for pathname in ["./a%41.ts", "./a%2541.ts", "./a%FF.ts", "./a.ts", "./%C3%A9"] {
            assert!(!has_malformed_escape(pathname), "{pathname}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn resolver_request_keeps_hash_and_question_mark_file_name_characters() {
        let base = Path::new("/base");
        let request = |path: &str| {
            resolver_request(base, path)
                .map(|(directory, specifier)| (directory.into_owned(), specifier.into_owned()))
        };
        // Plain and ASCII paths go through the specifier, `#` escaped.
        assert_eq!(request("./a.ts"), Some((base.into(), "./a.ts".into())));
        assert_eq!(request("/x/a#b.ts"), Some((base.into(), "/x/a\u{0}#b.ts".into())));
        assert_eq!(request("./é.ts"), Some((base.into(), "./é.ts".into())));
        // A `?` or a `#` beside non-ASCII text is kept in the directory.
        assert_eq!(request("/x/d?x/m.tsx"), Some((PathBuf::from("/x/d?x"), "./m.tsx".into())));
        assert_eq!(
            request("./p#õ/../q#õ/a#b.ts"),
            Some((PathBuf::from("/base/q#õ"), "./a\u{0}#b.ts".into()))
        );
        // Unless the file name itself holds one.
        assert_eq!(request("/x/w?.tsx"), None);
        assert_eq!(request("/x/é#x.ts"), None);
    }

    /// The watch recorder is process-wide, so its tests take turns, and each
    /// leaves it off and empty, as a fresh process has it.
    fn watch_lock() -> impl Drop {
        static LOCK: Mutex<()> = Mutex::new(());
        struct Reset(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);
        impl Drop for Reset {
            fn drop(&mut self) {
                WATCH_ENABLED.store(false, Ordering::Relaxed);
                *WATCH_QUEUE.lock().unwrap_or_else(PoisonError::into_inner) = Default::default();
            }
        }
        let guard = Reset(LOCK.lock().unwrap_or_else(PoisonError::into_inner));
        WATCH_ENABLED.store(false, Ordering::Relaxed);
        guard
    }

    /// A fresh project directory holding `files`.
    fn watch_fixture(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = env::temp_dir().join(format!("oxc-node-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for (file, contents) in files {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        // The resolver reports real paths (macOS keeps temp under a symlink);
        // Windows' canonical form is a verbatim `\\?\` path, so it stays as is.
        #[cfg(not(windows))]
        let root = fs::canonicalize(root).unwrap();
        root
    }

    fn sorted(mut urls: Vec<String>) -> Vec<String> {
        urls.sort();
        urls
    }

    fn url_of(path: &Path) -> String {
        path_to_file_url(&path.to_string_lossy())
    }

    #[test]
    fn watch_report_is_off_by_default() {
        let _lock = watch_lock();
        assert!(!watching());
        let file = env::temp_dir().join("tsconfig.json");
        report_watch_path(&file);
        assert!(take_watch_dependencies().is_empty());
        // Nothing recorded while it was off turns up once it is on.
        enable_watch_report();
        assert!(take_watch_dependencies().is_empty());
        report_watch_path(&file);
        assert_eq!(take_watch_dependencies(), [url_of(&file)]);
    }

    // Pins what `WatchFs` relies on: oxc_resolver reads tsconfig files, and only
    // those, with `read_to_string`, each once. Recheck on resolver upgrades.
    #[test]
    fn watch_report_records_each_tsconfig_once_and_never_package_json() {
        let _lock = watch_lock();
        let root = watch_fixture(
            "watch-tsconfig",
            &[
                ("package.json", r#"{ "type": "module" }"#),
                (
                    "tsconfig.json",
                    r#"{ "extends": "./cfg/base.json", "include": ["src"], "references": [{ "path": "./sub" }] }"#,
                ),
                ("cfg/base.json", r#"{ "extends": "./deeper.json" }"#),
                ("cfg/deeper.json", r#"{ "extends": "pkg/tsconfig.json" }"#),
                ("node_modules/pkg/package.json", r#"{ "name": "pkg" }"#),
                ("node_modules/pkg/tsconfig.json", r#"{ "compilerOptions": { "strict": true } }"#),
                ("sub/tsconfig.json", r#"{ "include": ["."] }"#),
                ("src/main.ts", ""),
                ("sub/a.ts", ""),
            ],
        );
        let resolver = Resolver::new(ResolveOptions {
            tsconfig: Some(TsconfigDiscovery::Auto),
            ..Default::default()
        });
        enable_watch_report();
        for _ in 0..2 {
            assert!(resolver.find_tsconfig(root.join("src/main.ts")).unwrap().is_some());
            assert!(resolver.find_tsconfig(root.join("sub/a.ts")).unwrap().is_some());
            // These read `package.json` files, through `read`.
            resolver.resolve(root.join("src"), "./main.ts").unwrap();
            resolver.resolve(&root, "pkg/package.json").unwrap();
        }
        let expected = sorted(
            [
                "cfg/base.json",
                "cfg/deeper.json",
                "node_modules/pkg/tsconfig.json",
                "sub/tsconfig.json",
                "tsconfig.json",
            ]
            .map(|file| url_of(&root.join(file)))
            .to_vec(),
        );
        assert_eq!(sorted(take_watch_dependencies()), expected);
        assert!(take_watch_dependencies().is_empty());
        // Another resolver reads the same files again; they are still reported once.
        let manual = Resolver::new(ResolveOptions {
            tsconfig: Some(TsconfigDiscovery::Manual(TsconfigOptions {
                config_file: root.join("tsconfig.json"),
                references: TsconfigReferences::Auto,
            })),
            ..Default::default()
        });
        manual.resolve_tsconfig(root.join("tsconfig.json")).unwrap();
        assert!(take_watch_dependencies().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn watch_report_records_a_missing_extends_target() {
        let _lock = watch_lock();
        let root = watch_fixture(
            "watch-missing-extends",
            &[
                ("tsconfig.json", r#"{ "extends": "./cfg/base.json", "include": ["src"] }"#),
                ("src/main.ts", ""),
            ],
        );
        let resolver = Resolver::new(ResolveOptions {
            tsconfig: Some(TsconfigDiscovery::Auto),
            ..Default::default()
        });
        enable_watch_report();
        assert!(resolver.find_tsconfig(root.join("src/main.ts")).is_err());
        let reported = take_watch_dependencies();
        for file in ["tsconfig.json", "cfg/base.json"] {
            assert!(reported.contains(&url_of(&root.join(file))), "{file}: {reported:?}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn watch_candidates_drop_noise() {
        #[cfg(not(windows))]
        let drive = Path::new("/");
        #[cfg(windows)]
        let drive = Path::new("C:\\");
        let p = |path: &str| drive.join(path);
        let missing = [
            p("p/src/later.tsx"),
            p("p/src/later.ts"),
            p("p/src/package.json"),
            p("p/package.json"),
            p("package.json"),
            p("p/node_modules"),
            p("p/node_modules/x/index.ts"),
            p("later.ts"),
        ];
        assert_eq!(watch_candidates(&missing), [&p("p/src/later.ts"), &p("p/src/later.tsx")]);
        let many: Vec<PathBuf> = (0..100).map(|i| p(&format!("p/{i:03}.ts"))).collect();
        let kept = watch_candidates(&many);
        assert_eq!(kept.len(), 64);
        assert_eq!(kept[0], &p("p/000.ts"));

        // What the resolver lists for a miss, with the project's extension order.
        let root = watch_fixture(
            "watch-candidates",
            &[("package.json", "{}"), ("src/main.ts", ""), ("src/dir/other.ts", "")],
        );
        let resolver = Resolver::new(source_order(ResolveOptions::default()));
        let candidates = |specifier: &str| {
            let mut context = ResolverContext::default();
            let resolved =
                resolver.resolve_with_context(root.join("src"), specifier, None, &mut context);
            assert!(resolved.is_err(), "{specifier}");
            watch_candidates(&context.missing_dependencies).into_iter().cloned().collect::<Vec<_>>()
        };
        let later = candidates("./later.js");
        assert!(later.contains(&root.join("src/later.ts")), "{later:?}");
        assert!(later.contains(&root.join("src/later.tsx")), "{later:?}");
        assert!(candidates("./later.mjs").contains(&root.join("src/later.mts")));
        assert!(candidates("./later.cjs").contains(&root.join("src/later.cts")));
        assert!(candidates("./dir").contains(&root.join("src/dir/index.ts")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn watch_report_urls_are_encoded_and_absolute_only() {
        let _lock = watch_lock();
        enable_watch_report();
        let file = env::temp_dir().join("a b").join("c#d.ts");
        report_watch_path(&file);
        report_watch_path(&file);
        report_watch_path(Path::new("relative/tsconfig.json"));
        let urls = take_watch_dependencies();
        assert_eq!(urls.len(), 1, "{urls:?}");
        assert!(urls[0].starts_with("file:///"), "{urls:?}");
        assert!(urls[0].ends_with("/a%20b/c%23d.ts"), "{urls:?}");
        assert_eq!(file_url_to_path(&urls[0]).as_deref(), Some(file.as_path()));
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_file_url_round_trips() {
        for path in ["/x/main#hash.ts", "/x/main%41.ts", "/x/main%file.ts", "/x/hash#dir/main.ts"] {
            let url = path_to_file_url(path);
            assert_eq!(file_url_to_path(&url), Some(PathBuf::from(path)), "{url}");
        }
        assert_eq!(path_to_file_url("/x/main#hash.ts"), "file:///x/main%23hash.ts");
        // The query and fragment are not part of the path.
        assert_eq!(
            file_url_to_path("file:///x/main%23hash.ts?v=a/b#c"),
            Some(PathBuf::from("/x/main#hash.ts"))
        );
        assert_eq!(file_url_to_path("file:///x/q%3Fx.ts"), Some(PathBuf::from("/x/q?x.ts")));
        // A raw backslash is a separator to the URL parser; an encoded one
        // is a file-name character.
        assert_eq!(file_url_to_path("file:///x/d\\a.ts"), Some(PathBuf::from("/x/d/a.ts")));
        assert_eq!(file_url_to_path("file:///x/d%5Ca.ts"), Some(PathBuf::from("/x/d\\a.ts")));
    }

    // `@oxc-node/core/importer`'s transform: which files are ES modules, the form
    // `require()` of one runs, and lines that stay where the source has them.
    #[test]
    fn module_runner_transform() {
        let root = env::temp_dir().join(format!("oxc-node-module-runner-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("esm")).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("esm/package.json"), r#"{ "type": "module" }"#).unwrap();
        let run = |name: &str, source: &str, sync: bool| {
            let path = root.join(name);
            fs::write(&path, source).unwrap();
            let path = path.to_string_lossy().into_owned();
            match transform_module_runner(path, Either::A(source.to_owned()), Some(sync)) {
                Ok(output) => output,
                // Dropping a napi `Error` calls into Node-API, which a test binary lacks.
                Err(error) => panic!("{}", mem::ManuallyDrop::new(error).reason),
            }
        };
        let lines = |code: &str, needle: &str| code.lines().position(|line| line.contains(needle));

        let imports = "import { x } from './dep.ts';\nexport const y: number = x;\n";
        let output = run("a.ts", imports, false);
        assert!(output.esm && !output.top_level_await);
        assert!(output.code.contains("await __vite_ssr_import__(\"./dep.ts\""), "{}", output.code);
        let output = run("a.ts", imports, true);
        assert!(output.code.contains("__vite_ssr_import__(\"./dep.ts\""), "{}", output.code);
        assert!(!output.code.contains("await"), "{}", output.code);

        // Module syntax or the package decides; the tsconfig never does.
        assert!(!run("cjs.ts", "module.exports = require('./dep');\n", false).esm);
        assert!(!run("plain.cts", "const n: number = 1;\nmodule.exports = n;\n", false).esm);
        assert!(run("plain.mts", "const n: number = 1;\n", false).esm);
        assert!(run("esm/plain.ts", "const n: number = 1;\n", false).esm);
        assert!(run("meta.ts", "console.log(import.meta.url);\n", false).esm);

        // Top-level await keeps the awaits in the sync form: it cannot run synchronously.
        let output = run("tla.mts", "import './dep.ts';\nawait 1;\n", true);
        assert!(output.esm && output.top_level_await);
        assert!(output.code.contains("await __vite_ssr_import__"), "{}", output.code);

        // A default and a namespace import from one declaration both stay bound.
        let output =
            run("both.ts", "import f, * as g from './dep.ts';\nexport const z = [f, g];\n", true);
        assert!(
            output.code.contains("[__vite_ssr_import_0__.default, __vite_ssr_import_1__]"),
            "{}",
            output.code
        );

        // A CommonJS file only hands `import()` to the runner.
        let output = run("lazy.cts", "module.exports = () => import('./dep.ts');\n", false);
        assert!(output.code.contains("__vite_ssr_dynamic_import__(\"./dep.ts\")"));

        // Each line starts on its source line, hashbang and hoisted exports aside.
        let source = "#!/usr/bin/env node\nenum E { A, B }\ninterface I { a: number }\n\
                      export function f(): never {\n  // why\n  throw new Error(`a\n  b`);\n}\n\
                      export { E };\n";
        let output = run("lines.ts", source, false);
        assert_eq!(lines(&output.code, "throw new Error"), Some(5), "{}", output.code);
        assert_eq!(lines(&output.code, "function f()"), Some(3), "{}", output.code);
        assert!(output.code.contains("`a\n  b`"), "{}", output.code);
        assert!(!output.code.contains("#!"), "{}", output.code);
        let map = SourceMap::from_json_string(output.map.as_deref().unwrap()).unwrap();
        let throw_line = map.get_tokens().find(|token| token.get_dst_line() == 5).unwrap();
        assert_eq!(throw_line.get_src_line(), 5);

        fs::remove_dir_all(&root).unwrap();
    }
}
