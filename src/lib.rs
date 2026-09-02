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
    codegen::{Codegen, CodegenOptions, CodegenReturn},
    diagnostics::OxcDiagnostic,
    parser::{Parser, ParserReturn},
    semantic::SemanticBuilder,
    span::SourceType,
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
    /// The `tsconfig.json` that governs `path`, if any.
    ///
    /// `path` must be an absolute file path (not a `file://` URL); the resolver
    /// returns `None` for anything else.
    fn for_path(&self, resolver: &Resolver, path: &Path) -> Option<Arc<TsConfig>> {
        match self {
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
    /// `oxc_resolver` applies TypeScript's own program-membership rule:
    /// `is_file_included_in_tsconfig` calls `is_extensionless_or_uncompiled_js`,
    /// which rejects `js` / `jsx` / `mjs` / `cjs` outright unless `allowJs` is
    /// set. No config ever claims a plain JavaScript file, so under auto
    /// discovery such a file would silently lose `paths` and `baseUrl` and fail
    /// to resolve its aliases at runtime.
    ///
    /// But "is this file an input to the TypeScript program" is not the question
    /// a loader is asking. The question is "which project does this file belong
    /// to, for the purpose of module resolution", and a `.mjs` file sitting in
    /// `src/` belongs to the same project as its `.ts` neighbours. So when
    /// nothing claims a JavaScript file, ask again as if it were TypeScript.
    ///
    /// The probe path never has to exist: `claims_ownership_of` only matches
    /// `files` / `include` / `exclude` globs and project references against the
    /// string, and stats nothing but the candidate `tsconfig.json` files it
    /// walks past. `exclude` therefore still wins — a directory the config
    /// excludes stays unclaimed for JavaScript and TypeScript alike.
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

#[cfg(not(target_os = "windows"))]
const PATH_PREFIX: &str = "file://";

#[cfg(target_os = "windows")]
const PATH_PREFIX: &str = "file:///";

/// Convert a `file://` URL into a filesystem path.
///
/// Node hands the loader hooks URLs, and a URL percent-encodes every character
/// outside the unreserved set: a space arrives as `%20`, `õ` as `%C3%B5`.
/// Slicing the scheme off without decoding leaves a string that still looks
/// like a path but names a directory nobody has — so tsconfig discovery walks
/// past the project and finds nothing, and relative specifiers resolve against
/// a directory that does not exist.
///
/// The `file:///C:/…` form needs no special casing: [`PATH_PREFIX`] already
/// carries the extra slash on Windows, so stripping it leaves the drive letter
/// at the front where it belongs.
///
/// Returns `None` if `url` is not a `file://` URL, or if its escapes do not
/// decode to valid UTF-8.
fn file_url_to_path(url: &str) -> Option<PathBuf> {
    let path = url.strip_prefix(PATH_PREFIX)?;
    if !path.contains('%') {
        return Some(PathBuf::from(path));
    }
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
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
    String::from_utf8(decoded).ok().map(PathBuf::from)
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
        )
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
        )
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

fn oxc_transform<S: TryAsStr>(
    src_path: &Path,
    code: &S,
    compiler_options: Option<&CompilerOptions>,
    module_target: Option<Module>,
    enable_top_level_await: bool,
) -> Result<Output> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(src_path).unwrap_or_default();
    let source_str = code.try_as_str()?;
    let ParserReturn { mut program, diagnostics, .. } =
        Parser::new(&allocator, source_str, source_type).parse();
    if !diagnostics.is_empty() {
        let msg = join_errors(diagnostics.into_vec(), source_str);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to parse {}: {}", src_path.display(), msg),
        ));
    }
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();

    let use_define_for_class_fields =
        compiler_options.and_then(|c| c.use_define_for_class_fields).unwrap_or_default();
    let TransformerReturn { diagnostics, .. } = Transformer::new(
        &allocator,
        src_path,
        &TransformOptions {
            assumptions: CompilerAssumptions {
                set_public_class_fields: use_define_for_class_fields,
                ..Default::default()
            },
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
                ..Default::default()
            },
            env: EnvOptions {
                module: module_target.unwrap_or_default(),
                es2022: ES2022Options {
                    class_static_block: true,
                    class_properties: Some(ClassPropertiesOptions {
                        loose: use_define_for_class_fields,
                    }),
                    // Turn this on would throw error for all top-level awaits.
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
    .build_with_scoping(scoping, &mut program);

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
        .build(&program);
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
    if specifier.ends_with(".json") {
        tracing::debug!("short-circuiting JSON resolve: {}", specifier);
        if context.import_attributes.contains_key("type") {
            return add_short_circuit(specifier, Some("json"), context, next_resolve);
        }
        return add_short_circuit(specifier, Some("module"), context, next_resolve);
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

    let is_absolute_path = specifier.starts_with(PATH_PREFIX);

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
            resolver.resolve(Path::new("/"), &specifier_path.to_string_lossy())
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
            let tsconfig = tsconfig_source.for_path(resolver, parent_file);
            resolver.resolve_with_context(
                directory,
                &specifier,
                tsconfig.as_deref(),
                &mut ResolverContext::default(),
            )
        }
        _ => resolver.resolve(directory, &specifier),
    };

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

    add_short_circuit(specifier, None, context, next_resolve)
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

fn transform_output(
    url: String,
    output: LoadFnOutput,
    resolved_compiler_options: Option<&CompilerOptions>,
) -> Result<LoadFnOutput> {
    match &output.source {
        Some(Either4::D(_)) | None => {
            tracing::debug!("No source code to transform {}", url);
            Ok(LoadFnOutput { format: output.format, source: None, response_url: Some(url) })
        }
        Some(Either4::A(_) | Either4::B(_) | Either4::C(_)) => {
            let src_path = Path::new(&url);
            // url is a file path, so it's always unix style path separator in it
            if env::var("OXC_TRANSFORM_ALL")
                .map(|value| value.is_empty() || value == "0" || value == "false")
                .unwrap_or(true)
                && url.contains("/node_modules/")
            {
                tracing::debug!("Skip transforming node_modules {}", url);
                return Ok(output);
            }
            let ext = src_path.extension().and_then(|ext| ext.to_str());

            if ext.map(|ext| ext == "json").unwrap_or(false) {
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
                return Ok(LoadFnOutput {
                    format: "commonjs".to_owned(),
                    source: Some(Either4::A(format!("module.exports = {source_str}"))),
                    response_url: Some(url),
                });
            }

            let transform_output = oxc_transform(
                src_path,
                output.source.as_ref().unwrap(),
                resolved_compiler_options,
                Some(Module::Preserve),
                output.format != "module",
            )?;
            let output_code = transform_output
                .map
                .map(|sm| {
                    let sm = sm.to_data_url();
                    const SOURCEMAP_PREFIX: &str = "\n//# sourceMappingURL=";
                    let len = sm.len() + transform_output.code.len() + 22;
                    let mut output_code = String::with_capacity(len + 22);
                    output_code.push_str(&transform_output.code);
                    output_code.push_str(SOURCEMAP_PREFIX);
                    output_code.push_str(sm.as_str());
                    output_code
                })
                .unwrap_or_else(|| transform_output.code);
            tracing::debug!("loaded {} format: {}", url, output.format);
            Ok(LoadFnOutput {
                format: output.format,
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

fn oxc_resolved_path_to_url(resolution: &Resolution) -> String {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut url = if resolution.query().is_some() || resolution.fragment().is_some() {
        format!("{PATH_PREFIX}{}", resolution.full_path().to_string_lossy())
    } else {
        format!("{PATH_PREFIX}{}", resolution.path().to_string_lossy())
    };
    #[cfg(target_os = "windows")]
    {
        url = url.replace("\\", "/");
    }
    url
}
