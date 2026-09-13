use std::{
    borrow::Cow,
    collections::HashMap,
    env, fs, mem,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use oxc::{
    allocator::Allocator,
    ast::ast::{Program, Statement},
    codegen::{Codegen, CodegenOptions, CodegenReturn},
    diagnostics::{Diagnostics, OxcDiagnostic},
    parser::{Parser, ParserReturn},
    semantic::SemanticBuilder,
    span::SourceType,
    syntax::module_record::ModuleRecord,
    transformer::{
        ClassPropertiesOptions, CompilerAssumptions, DecoratorOptions, ES2022Options,
        ES2026Options, EnvOptions, HelperLoaderOptions, JsxOptions, JsxRuntime, Module,
        ProposalOptions, RewriteExtensionsMode, TransformOptions, Transformer, TransformerReturn,
        TypeScriptOptions,
    },
};
use oxc_resolver::{
    CompilerOptions, EnforceExtension, ModuleType, Resolution, ResolveContext as ResolverContext,
    ResolveOptions, Resolver, TsConfig, TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
};
use oxc_sourcemap::SourceMap;
use phf::Set;

#[cfg(all(
    not(target_arch = "x86"),
    not(target_arch = "arm"),
    not(target_family = "wasm"),
    not(all(target_os = "windows", target_arch = "aarch64"))
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
/// * [`TsconfigDiscovery::Manual`] pins one config for the whole process. It is
///   also the only mode that [`Resolver::resolve`] consults, because that API
///   goes through `manual_tsconfig()` internally.
/// * [`TsconfigDiscovery::Auto`] resolves a config per file, and [`Resolver::resolve`]
///   ignores it entirely. Only [`Resolver::find_tsconfig`] sees it, so under `Auto`
///   the config is looked up here and handed to `resolve_with_context`.
enum TsconfigSource {
    /// An explicit config requested through `TS_NODE_PROJECT` or
    /// `OXC_TSCONFIG_PATH`. The exact same config applies to every file,
    /// including files inside `node_modules`.
    ///
    /// `None` means the requested path does not exist. That deliberately leaves
    /// the process with no config at all instead of falling back to discovery:
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
    /// resolve against — [`Self::for_path`], plus a fallback for JavaScript.
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
    /// The probe path never has to exist: `claims_ownership_of` only matches
    /// `files` / `include` / `exclude` globs and project references against the
    /// string, and stats nothing but the candidate `tsconfig.json` files it walks
    /// past.
    fn for_importer(&self, resolver: &Resolver, path: &Path) -> Option<Arc<TsConfig>> {
        match self {
            // An explicitly named config already applies to every file, so there
            // is nothing for the probe to recover.
            Self::Manual(tsconfig) => tsconfig.clone(),
            Self::Auto => Self::discover(resolver, path).or_else(|| {
                Self::probe_as_typescript(path)
                    .and_then(|probe| Self::discover(resolver, &probe))
                    .inspect(
                        |_| tracing::debug!(path = ?path, "tsconfig found via TypeScript probe"),
                    )
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
    fn discover(resolver: &Resolver, path: &Path) -> Option<Arc<TsConfig>> {
        match resolver.find_tsconfig(path) {
            Ok(tsconfig) => tsconfig,
            Err(err) => {
                tracing::debug!(path = ?path, error = ?err, "failed to discover tsconfig");
                None
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

static RESOLVER_AND_TSCONFIG: OnceLock<(Resolver, TsconfigSource)> = OnceLock::new();

#[cfg(not(target_os = "windows"))]
const NODE_MODULES_PATH: &str = "/node_modules/";

#[cfg(target_os = "windows")]
const NODE_MODULES_PATH: &str = "\\node_modules\\";

/// Convert a `file://` URL into a filesystem path.
///
/// Node hands the loader hooks URLs, and a URL percent-encodes every character
/// outside the unreserved set: a space arrives as `%20`, `õ` as `%C3%B5`.
/// Slicing the scheme off without decoding leaves a string that still looks
/// like a path but names a directory nobody has — so tsconfig discovery walks
/// past the project and finds nothing, and relative specifiers resolve against
/// a directory that does not exist.
///
/// Returns `None` if `url` is not a `file://` URL, or if its escapes do not
/// decode to valid UTF-8.
#[cfg(not(windows))]
fn file_url_to_path(url: &str) -> Option<PathBuf> {
    // The URL parser removes every ASCII tab or newline before parsing.
    let cleaned;
    let url = if url.contains(['\t', '\n', '\r']) {
        cleaned = url.replace(['\t', '\n', '\r'], "");
        &cleaned
    } else {
        url
    };
    let rest = url.strip_prefix("file://")?;
    // The query and fragment are not part of the filesystem path; Node
    // decodes the pathname only.
    let (rest, _suffix) = match rest.find(['?', '#']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    percent_decode_to_path(rest)
}

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

/// Decode one URL component straight into a path; see [`percent_decode`].
fn percent_decode_to_path(input: &str) -> Option<PathBuf> {
    percent_decode(input).map(|text| PathBuf::from(text.into_owned()))
}

/// Percent-decode one URL component, validating the decoded bytes as UTF-8.
///
/// Two vectorised passes carry this function, and the byte loop only ever
/// runs over the escaped tail.
///
/// `memchr` compares a vector register at a time, dispatching to SSE2 or
/// AVX2 on x86 and NEON on aarch64 at runtime. Most URLs hold no escape at
/// all, and for those this single scan is the whole function: no allocation,
/// no copy, no decode loop.
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

    // Do not be tempted to `memchr` again per gap and bulk-copy between
    // escapes. Escaped paths have short gaps — one non-ASCII character is three
    // consecutive escapes — and a `memchr` call per gap costs more than the
    // bytes it saves. Measured on a percent-encoded CJK path it was 90% slower
    // than the loop above.
    //
    // The decoded bytes are arbitrary, so they still need validating. This is
    // the second vectorised pass, and it is where escape-heavy paths win most.
    let text = simdutf8::basic::from_utf8(&decoded).ok()?;
    Some(Cow::Owned(text.to_owned()))
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(target_family = "wasm")]
#[napi]
pub fn init_tracing() {
    init();
}

#[cfg(not(target_family = "wasm"))]
#[napi]
pub fn init_tracing() {}

#[cfg_attr(not(target_family = "wasm"), napi_derive::module_init)]
fn init() {
    use tracing_subscriber::filter::Targets;
    use tracing_subscriber::prelude::__tracing_subscriber_SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    // Usage without the `regex` feature.
    // <https://github.com/tokio-rs/tracing/issues/1436#issuecomment-918528013>
    tracing_subscriber::registry()
        .with(std::env::var("OXC_LOG").map_or_else(
            |_| Targets::new(),
            |env_var| {
                use std::str::FromStr;
                Targets::from_str(&env_var).unwrap()
            },
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();
}

#[napi]
pub struct Output {
    code: String,
    map: Option<SourceMap<'static>>,
}

#[napi]
impl Output {
    #[napi]
    /// Returns the generated code
    /// Cache the result of this function if you need to use it multiple times
    pub fn source(&self) -> String {
        self.code.clone()
    }

    #[napi]
    /// Returns the source map as a JSON string
    /// Cache the result of this function if you need to use it multiple times
    pub fn source_map(&self) -> Option<String> {
        self.map.as_ref().map(|source_map| source_map.to_json_string())
    }
}

#[napi]
pub fn transform(path: String, source: Either<String, &[u8]>) -> Result<Output> {
    let transformer = OxcTransformer::new(None);
    transformer.transform(path, source)
}

#[napi]
pub fn transform_async(
    path: String,
    source: Either3<String, Uint8Array, Buffer>,
) -> AsyncTask<TransformTask> {
    let transformer = OxcTransformer::new(None);
    transformer.transform_async(path, source)
}

pub struct TransformTask {
    cwd: String,
    path: String,
    source: Either3<String, Uint8Array, Buffer>,
}

#[napi]
impl Task for TransformTask {
    type Output = Output;
    type JsValue = Output;

    fn compute(&mut self) -> Result<Self::Output> {
        let src_path = Path::new(&self.path);
        let cwd = PathBuf::from(&self.cwd);
        // Worked out before `cwd` is moved into the initialiser.
        let lookup_path = tsconfig_lookup_path(&cwd, src_path).into_owned();
        let (resolver, tsconfig_source) =
            RESOLVER_AND_TSCONFIG.get_or_init(|| init_resolver(cwd, vec![]));
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

#[napi]
pub struct OxcTransformer {
    cwd: String,
}

#[napi]
impl OxcTransformer {
    #[napi(constructor)]
    pub fn new(cwd: Option<String>) -> Self {
        Self {
            cwd: match cwd {
                Some(cwd) => cwd,
                None => env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap(),
            },
        }
    }

    #[napi]
    pub fn transform(&self, path: String, source: Either<String, &[u8]>) -> Result<Output> {
        let cwd = PathBuf::from(&self.cwd);
        let src_path = Path::new(&path);
        // Worked out before `cwd` is moved into the initialiser.
        let lookup_path = tsconfig_lookup_path(&cwd, src_path).into_owned();
        let (resolver, tsconfig_source) =
            RESOLVER_AND_TSCONFIG.get_or_init(|| init_resolver(cwd, vec![]));
        let resolved_tsconfig = tsconfig_source.for_path(resolver, &lookup_path);
        oxc_transform(
            src_path,
            &source,
            resolved_tsconfig.as_ref().map(|t| &t.compiler_options),
            Some(Module::CommonJS),
            true,
            false,
        )
        .map(|(output, _)| output)
    }

    #[napi]
    pub fn transform_async(
        &self,
        path: String,
        source: Either3<String, Uint8Array, Buffer>,
    ) -> AsyncTask<TransformTask> {
        AsyncTask::new(TransformTask { path, source, cwd: self.cwd.clone() })
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
    !module_record.import_metas.is_empty()
        || program.body.iter().any(|statement| {
            matches!(
                statement,
                Statement::ImportDeclaration(_)
                    | Statement::ExportAllDeclaration(_)
                    | Statement::ExportDefaultDeclaration(_)
                    | Statement::ExportDeclaration(_)
                    | Statement::ExportNamedDeclaration(_)
                    | Statement::ExportFromDeclaration(_)
            )
        })
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

fn oxc_transform<S: TryAsStr>(
    src_path: &Path,
    code: &S,
    compiler_options: Option<&CompilerOptions>,
    module_target: Option<Module>,
    enable_top_level_await: bool,
    is_es_module: bool,
) -> Result<(Output, bool)> {
    let allocator = Allocator::default();
    // `.js`, `.jsx`, `.ts` and `.tsx` are ambiguous: oxc decides between a script and an ES
    // module by looking for `import`/`export` syntax, so a file that has none is treated as
    // a script and the helper loader emits `require()` for the helpers it injects. Node.js
    // decides from the nearest `package.json` instead and would then run that `require()` in
    // an ES module. Only the caller knows which it is, so let it say.
    let source_type = SourceType::from_path(src_path).unwrap_or_default().with_module(is_es_module);
    let source_str = code.try_as_str()?;
    let allow_module_retry = !is_es_module
        && matches!(module_target, Some(Module::Preserve))
        && source_type.is_unambiguous();
    let Parsed { mut program, diagnostics, module_record, only_module_parse } =
        parse_source(&allocator, source_str, source_type, allow_module_retry);
    if !diagnostics.is_empty() {
        let msg = join_errors(diagnostics.into_vec(), source_str);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to parse {}: {}", src_path.display(), msg),
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

    let output = transform_program(
        &allocator,
        src_path,
        &mut program,
        source_str,
        compiler_options,
        module_target,
        enable_top_level_await && !flip_to_module,
    )?;
    Ok((output, flip_to_module))
}

/// Semantic analysis, transform and codegen for an already-parsed program. Split from
/// parsing so the CommonJS sniff path can decide from the parse result and transform
/// straight away, without a second parse.
fn transform_program<'a>(
    allocator: &'a Allocator,
    src_path: &Path,
    program: &mut Program<'a>,
    source_str: &str,
    compiler_options: Option<&CompilerOptions>,
    module_target: Option<Module>,
    enable_top_level_await: bool,
) -> Result<Output> {
    let scoping = SemanticBuilder::new().build(program).semantic.into_scoping();

    let use_define_for_class_fields = use_define_for_class_fields(compiler_options);
    // `useDefineForClassFields` selects `[[Define]]` semantics; oxc's `setPublicClassFields`
    // assumption selects the opposite, `[[Set]]`, so it is the negation of it.
    let set_public_class_fields = !use_define_for_class_fields;
    let TransformerReturn { diagnostics, .. } = Transformer::new(
        allocator,
        src_path,
        &TransformOptions {
            assumptions: CompilerAssumptions { set_public_class_fields, ..Default::default() },
            decorator: DecoratorOptions {
                legacy: compiler_options.and_then(|c| c.experimental_decorators).unwrap_or(false),
                emit_decorator_metadata: compiler_options
                    .and_then(|c| c.emit_decorator_metadata)
                    .unwrap_or(false),
                strict_null_checks: compiler_options
                    .and_then(|c| c.strict_null_checks)
                    .unwrap_or(false),
            },
            jsx: JsxOptions {
                runtime: compiler_options
                    .and_then(|c| c.jsx.as_ref())
                    .map(|s| match s.as_str() {
                        "automatic" => JsxRuntime::Automatic,
                        "classic" => JsxRuntime::Classic,
                        _ => JsxRuntime::default(),
                    })
                    .unwrap_or_default(),
                import_source: compiler_options.and_then(|c| c.jsx_import_source.clone()),
                pragma: compiler_options.and_then(|c| c.jsx_factory.clone()),
                pragma_frag: compiler_options.and_then(|c| c.jsx_fragment_factory.clone()),
                ..Default::default()
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
                only_remove_type_imports: false,
                // With `[[Set]]` semantics, `tsc` also drops class fields that have no
                // initializer instead of assigning `undefined` through the prototype chain
                // (which would fire an inherited setter). oxc only does that when asked.
                remove_class_fields_without_initializer: set_public_class_fields,
                ..Default::default()
            },
            env: EnvOptions {
                module: module_target.unwrap_or_default(),
                es2022: ES2022Options {
                    class_static_block: true,
                    // `loose` stays `false`: it would also lower `#private` fields to
                    // string-keyed properties, which `tsc` never does. The assumption
                    // above alone selects `[[Set]]` for public fields — the transformer
                    // ORs the two together.
                    class_properties: Some(ClassPropertiesOptions::default()),
                    // Turn this on would throw error for all top-level awaits; the caller
                    // clears it for a file flipping to an ES module, which keeps them.
                    top_level_await: enable_top_level_await,
                },
                es2026: ES2026Options { explicit_resource_management: true },
                ..Default::default()
            },
            proposals: ProposalOptions {},
            helper_loader: HelperLoaderOptions {
                module_name: Cow::Borrowed("@oxc-node/core"),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .build_with_scoping(scoping, program);

    if !diagnostics.is_empty() {
        let msg = join_errors(diagnostics.into_vec(), source_str);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to transform {}: {}", src_path.display(), msg),
        ));
    }

    let CodegenReturn { code, map, .. } = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(src_path.to_path_buf()),
            ..Default::default()
        })
        .build(program);
    Ok(Output { code, map: map.map(|source_map| source_map.into_owned()) })
}

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

#[napi]
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
    tracing::debug!(specifier = ?specifier, context = ?context);
    if specifier.starts_with("node:") || specifier.starts_with("nodejs:") {
        tracing::debug!("short-circuiting builtin protocol resolve: {}", specifier);
        return add_short_circuit(specifier, Some("builtin"), context, next_resolve);
    }
    if BUILTIN_MODULES.contains(specifier.as_str()) {
        tracing::debug!("short-circuiting builtin resolve: {}", specifier);
        return add_short_circuit(specifier, Some("builtin"), context, next_resolve);
    }
    if specifier.starts_with("data:") {
        tracing::debug!("short-circuiting data URL resolve: {}", specifier);
        return add_short_circuit(specifier, Some("builtin"), context, next_resolve);
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

    let conditions = context.conditions.as_slice();

    let (resolver, tsconfig_source) =
        RESOLVER_AND_TSCONFIG.get_or_init(|| init_resolver(cwd.clone(), conditions.to_vec()));

    // A `file:` URL is an absolute path in every form Node.js hands over,
    // UNC `file://server/…` included.
    let is_absolute_path = specifier.starts_with("file://");

    // The importing file itself, when the parent URL is a file URL. Discovery
    // needs the file rather than its directory, because `TsconfigDiscovery::Auto`
    // matches a config's `files` / `include` / `exclude` against the file path.
    let parent_file =
        match context.parent_url.as_deref() {
            Some(parent) => Some(file_url_to_path(parent).ok_or_else(|| {
                Error::new(Status::GenericFailure, "Parent URL is not a file URL")
            })?),
            None => None,
        };
    let parent_file = parent_file.as_deref();

    let directory = match parent_file {
        Some(parent_file) => parent_file
            .parent()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Parent URL is not a file URL"))?,
        None => cwd.as_path(),
    };
    tracing::debug!(directory = ?directory);

    let resolution = match (is_absolute_path, tsconfig_source, parent_file) {
        (true, ..) => {
            let specifier_path = file_url_to_path(&specifier)
                .ok_or_else(|| Error::new(Status::GenericFailure, "Specifier is not a file URL"))?;
            // The path is fully decoded, so a literal `#` in a file name would
            // be parsed as a fragment here and a same-named prefix file would
            // win (`a` over `a#b.ts`); the resolver's enhanced-resolve escape
            // keeps the hash a filename character. The query/fragment are not
            // part of the path — `file_url_to_path` drops them — so re-attach
            // the raw suffix afterwards, where it stays module identity.
            let escaped = specifier_path.to_string_lossy().replace('#', "\u{0}#");
            match specifier.find(['?', '#']) {
                Some(index) => {
                    let mut with_suffix = escaped;
                    with_suffix.push_str(&specifier[index..]);
                    resolver.resolve(Path::new("/"), &with_suffix)
                }
                None => resolver.resolve(Path::new("/"), &escaped),
            }
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
        (false, TsconfigSource::Auto, Some(parent_file)) => {
            let tsconfig = tsconfig_source.for_importer(resolver, parent_file);
            resolver.resolve_with_context(
                directory,
                &specifier,
                tsconfig.as_deref(),
                &mut ResolverContext::default(),
            )
        }
        _ => resolver.resolve(directory, &specifier),
    };

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
        let url = oxc_resolved_path_to_url(resolved);
        return add_short_circuit(url, Some(format), context, next_resolve);
    }

    // import attributes
    if !context.import_attributes.is_empty() {
        tracing::debug!(
            "short-circuiting import attributes resolve: {}, attributes: {:?}",
            specifier,
            context.import_attributes
        );
        return next_resolve.call((specifier, Some(context)).into());
    };

    if let Ok(resolution) = resolution {
        tracing::debug!(resolution = ?resolution, "resolved");
        let p = resolution.path();
        let url = oxc_resolved_path_to_url(&resolution);
        if !p.to_str().map(|p| p.contains(NODE_MODULES_PATH)).unwrap_or(false) {
            let format = {
                let ext = p.extension().and_then(|ext| ext.to_str());

                let format = ext
                    .and_then(|ext| match ext {
                        "cjs" | "cts" | "node" => None,
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
                                _ => None,
                            }
                        }
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

    add_short_circuit(specifier, None, context, next_resolve)
}

/// The format to report for a JSON module: `json` when the caller wrote an import
/// attribute, `module` otherwise so that [`load`] can synthesise its named exports.
fn json_format(context: &ResolveContext) -> &'static str {
    if context.import_attributes.contains_key("type") { "json" } else { "module" }
}

#[napi(object)]
#[derive(Debug)]
pub struct LoadContext {
    /// Export conditions of the relevant `package.json`
    pub conditions: Option<Vec<String>>,
    /// The format optionally supplied by the `resolve` hook chain
    pub format: Either<String, Null>,
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

#[napi]
#[allow(clippy::type_complexity)]
pub fn load<'env>(
    url: String,
    context: LoadContext,
    next_load: Function<
        'env,
        FnArgs<(String, Option<LoadContext>)>,
        Either<LoadFnOutput, PromiseRaw<'env, LoadFnOutput>>,
    >,
) -> Result<Either<LoadFnOutput, PromiseRaw<'env, LoadFnOutput>>> {
    tracing::debug!(url = ?url, context = ?context, "load");
    if url.starts_with("data:") || {
        match context.format {
            Either::A(ref format) => format == "builtin" || format == "json" || format == "wasm",
            _ => true,
        }
    } {
        tracing::debug!("short-circuiting load: {}", url);
        return next_load.call((url, Some(context)).into());
    }

    let loaded = next_load.call((url.clone(), Some(context)).into())?;
    let (resolver, tsconfig_source) = RESOLVER_AND_TSCONFIG
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
        )?)),
        // The config is owned, so move it into the callback and borrow from it
        // there; the callback outlives this function and must be `'static`.
        Either::B(promise) => promise
            .then(move |ctx| {
                transform_output(
                    url,
                    ctx.value,
                    tsconfig.as_ref().map(|tsconfig| &tsconfig.compiler_options),
                )
            })
            .map(Either::B),
    }
}

/// Node.js does not read CommonJS modules for the `load` hook: its default load returns
/// no source and lets the CJS machinery fetch the file later. The format was decided from
/// the outside, though — a `.ts`/`.js` file in a CommonJS package that contains ESM syntax
/// is an ES module to Node.js (it runs as one when `require()`d), and reporting it as
/// `commonjs` breaks both entry points (`ERR_REQUIRE_CYCLE_MODULE`) and named imports
/// (`cjs-module-lexer` finds no exports). Read the file and check what it really is,
/// transforming it right away when it is an ES module; anything else falls through
/// untouched. The parse is shared with the transform, so a flipped file is parsed once.
fn load_commonjs_esm(
    url: &str,
    output: &LoadFnOutput,
    resolved_compiler_options: Option<&CompilerOptions>,
) -> Result<Option<LoadFnOutput>> {
    if output.format != "commonjs" {
        return Ok(None);
    }
    // The same skip as the transform below: dependencies are left alone unless asked for.
    if env::var("OXC_TRANSFORM_ALL")
        .map(|value| value.is_empty() || value == "0" || value == "false")
        .unwrap_or(true)
        && url.contains("/node_modules/")
    {
        return Ok(None);
    }
    // A `?query` or `#fragment` suffix belongs to the module URL, not to the file on disk.
    let Some(path) = file_url_to_path(url_path(url)) else { return Ok(None) };
    let Ok(source_type) = SourceType::from_path(&path) else { return Ok(None) };
    // Only the ambiguous extensions may flip: `.cts`/`.cjs` are CommonJS by contract, and
    // their source type emits `require()` for helpers, which an ES module cannot run.
    if !source_type.is_unambiguous() {
        return Ok(None);
    }
    // `read_to_string` would validate UTF-8 with std's scalar check; the SIMD pass is the
    // one `file_url_to_path` uses, and borrowing the bytes skips the copy into a String.
    let Ok(bytes) = std::fs::read(&path) else { return Ok(None) };
    let Ok(source) = simdutf8::basic::from_utf8(&bytes) else { return Ok(None) };
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
        let msg = join_errors(diagnostics.into_vec(), source);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to parse {}: {}", path.display(), msg),
        ));
    }
    // A module keeps its top-level awaits, hence the last `false`.
    let transformed = transform_program(
        &allocator,
        &path,
        &mut program,
        source,
        resolved_compiler_options,
        Some(Module::Preserve),
        false,
    )?;
    tracing::debug!("loaded {} format: module", url);
    Ok(Some(LoadFnOutput {
        format: "module".to_owned(),
        source: Some(Either4::B(Uint8Array::from_string(code_with_inline_map(transformed)))),
        response_url: Some(url.to_owned()),
    }))
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

fn transform_output(
    url: String,
    output: LoadFnOutput,
    resolved_compiler_options: Option<&CompilerOptions>,
) -> Result<LoadFnOutput> {
    match &output.source {
        Some(Either4::D(_)) | None => {
            if let Some(loaded) = load_commonjs_esm(&url, &output, resolved_compiler_options)? {
                return Ok(loaded);
            }
            tracing::debug!("No source code to transform {}", url);
            Ok(LoadFnOutput { format: output.format, source: None, response_url: Some(url) })
        }
        Some(Either4::A(_) | Either4::B(_) | Either4::C(_)) => {
            // `url` is a URL, so a `?query` or `#fragment` has to be stripped before it can
            // be treated as a path, and the separators are always forward slashes.
            let src_path = Path::new(url_path(&url));
            let ext = src_path.extension().and_then(|ext| ext.to_str());
            let is_json = ext.is_some_and(|ext| ext.eq_ignore_ascii_case("json"));

            // Turning JSON into a module is not a code transform, so it happens for
            // dependencies too — `OXC_TRANSFORM_ALL` decides whether their *source* is
            // transpiled, and skipping this would hand Node.js raw JSON to run as an ES
            // module.
            if !is_json
                && env::var("OXC_TRANSFORM_ALL")
                    .map(|value| value.is_empty() || value == "0" || value == "false")
                    .unwrap_or(true)
                && url.contains("/node_modules/")
            {
                tracing::debug!("Skip transforming node_modules {}", url);
                return Ok(output);
            }

            if is_json {
                let source_str = output.source.as_ref().unwrap().try_as_str()?;
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

            let is_es_module = output.format == "module";
            let (transform_output, flipped_to_module) = oxc_transform(
                src_path,
                output.source.as_ref().unwrap(),
                resolved_compiler_options,
                Some(Module::Preserve),
                !is_es_module,
                is_es_module,
            )?;
            // A CommonJS-reported file that turned out to be an ES module is handed back
            // as one, so Node.js never tries to compile its `import`/`export` as CommonJS.
            let format = if flipped_to_module { "module".to_owned() } else { output.format };
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
    fn try_as_str(&self) -> Result<&str>;
}

impl TryAsStr for Either<String, &[u8]> {
    fn try_as_str(&self) -> Result<&str> {
        match self {
            Either::A(s) => Ok(s),
            Either::B(b) => std::str::from_utf8(b).map_err(|err| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to convert &[u8] to &str: {err}"),
                )
            }),
        }
    }
}

impl TryAsStr for Either3<String, Uint8Array, Buffer> {
    fn try_as_str(&self) -> Result<&str> {
        match self {
            Either3::A(s) => Ok(s),
            Either3::B(arr) => std::str::from_utf8(arr).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Uint8Array to Vec<u8>")
            }),
            Either3::C(buf) => std::str::from_utf8(buf).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Buffer to Vec<u8>")
            }),
        }
    }
}

impl TryAsStr for Either4<String, Uint8Array, Buffer, Null> {
    fn try_as_str(&self) -> Result<&str> {
        match self {
            Either4::A(s) => Ok(s),
            Either4::B(arr) => std::str::from_utf8(arr).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Uint8Array to Vec<u8>")
            }),
            Either4::C(buf) => std::str::from_utf8(buf).map_err(|_| {
                Error::new(Status::GenericFailure, "Failed to convert Buffer to Vec<u8>")
            }),
            Either4::D(_) => {
                Err(Error::new(Status::InvalidArg, "Invalid value type in LoadFnOutput::source"))
            }
        }
    }
}

/// Read an environment variable, treating an empty value as unset.
///
/// Continuous integration wrappers and `.env` files routinely export variables
/// with an empty value. Without this, an empty `TS_NODE_PROJECT` counts as set,
/// shadows a perfectly good `OXC_TSCONFIG_PATH`, and leaves the process with no
/// tsconfig at all.
fn non_empty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
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

fn init_resolver(cwd: PathBuf, conditions: Vec<String>) -> (Resolver, TsconfigSource) {
    // An explicitly requested config always wins over discovery.
    let explicit_tsconfig =
        non_empty_env("TS_NODE_PROJECT").or_else(|| non_empty_env("OXC_TSCONFIG_PATH"));
    tracing::debug!(explicit_tsconfig = ?explicit_tsconfig);

    let explicit_tsconfig_path = explicit_tsconfig.map(|tsconfig| {
        let tsconfig = PathBuf::from(tsconfig);
        // `starts_with('/')` would misjudge `C:\...` on Windows.
        if tsconfig.is_absolute() { tsconfig } else { cwd.join(tsconfig) }
    });
    tracing::debug!(explicit_tsconfig_path = ?explicit_tsconfig_path);

    let tsconfig = match &explicit_tsconfig_path {
        // Pointing `Manual` at a file that does not exist would make *every*
        // `resolve()` call fail, so disable tsconfig handling instead. Falling
        // back to `Auto` is not an option: an explicit request for a missing
        // config must not quietly pick up a different one.
        Some(path) if fs::exists(path).unwrap_or(false) => {
            Some(TsconfigDiscovery::Manual(TsconfigOptions {
                config_file: path.clone(),
                references: TsconfigReferences::Auto,
            }))
        }
        Some(_) => None,
        // Nothing was requested: let the resolver find, per file, the nearest
        // `tsconfig.json` that actually claims it.
        None => Some(TsconfigDiscovery::Auto),
    };

    let resolver = Resolver::new(ResolveOptions {
        tsconfig,
        condition_names: conditions,
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
        Some(path) => TsconfigSource::Manual(resolver.resolve_tsconfig(path).ok()),
        None => TsconfigSource::Auto,
    };

    (resolver, tsconfig_source)
}

fn join_errors(errors: Vec<OxcDiagnostic>, source_str: &str) -> String {
    errors
        .into_iter()
        .map(|err| err.with_source_code(source_str.to_owned()).to_string())
        .collect::<Vec<_>>()
        .join("\n")
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

/// The path part of a URL or specifier, i.e. everything before a `?query` or `#fragment`.
///
/// Extensions must be matched against this and not against the whole string: oxc-node
/// supports `import "./mod.ts?v=1"`, and `Path::extension()` on the full URL would report
/// `ts?v=1`.
fn url_path(url: &str) -> &str {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    &url[..end]
}

fn oxc_resolved_path_to_url(resolution: &Resolution) -> String {
    // The path goes through `path_to_file_url` on its own: its percent-encode
    // set differs from the raw query and fragment, which must be appended
    // verbatim or a `?`/`#` inside the path would be misparsed.
    let mut url = path_to_file_url(&resolution.path().to_string_lossy());
    if let Some(query) = resolution.query() {
        url.push('?');
        url.push_str(query);
    }
    if let Some(fragment) = resolution.fragment() {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

/// Generate a `file:` URL from an absolute path.
#[cfg(not(windows))]
fn path_to_file_url(path: &str) -> String {
    format!("file://{path}")
}

/// Generate a `file:` URL from an absolute path, following the `pathToFileURL`
/// rules: a `\\` or `//` prefix makes the first component the UNC authority —
/// percent-encoded — and everything else keeps the `file:///<drive>:/…` form.
#[cfg(windows)]
fn path_to_file_url(path: &str) -> String {
    windows_file_url::path_to_url(path)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    // The Windows `file:` URL matrix lives with the module in
    // windows_file_url.rs; what remains here is the platform behavior this
    // file owns.

    #[cfg(not(windows))]
    #[test]
    fn non_windows_behavior_is_unchanged() {
        assert_eq!(file_url_to_path("file:///a/b.ts"), Some(PathBuf::from("/a/b.ts")));
        assert_eq!(file_url_to_path("file:///a%20b.ts"), Some(PathBuf::from("/a b.ts")));
        assert_eq!(path_to_file_url("/a/b.ts"), "file:///a/b.ts");
    }
}
