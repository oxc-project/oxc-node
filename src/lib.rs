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
        ClassPropertiesOptions, CompilerAssumptions, DecoratorOptions, ES2022Options, EnvOptions,
        HelperLoaderOptions, JsxOptions, JsxRuntime, Module, ProposalOptions,
        RewriteExtensionsMode, TransformOptions, Transformer, TransformerReturn, TypeScriptOptions,
    },
};
use oxc_resolver::{
    CompilerOptions, EnforceExtension, ModuleType, Resolution, ResolveOptions, Resolver, TsConfig, TsconfigOptions, TsconfigReferences
};
use phf::Set;

#[cfg(all(
    not(target_arch = "x86"),
    not(target_arch = "arm"),
    not(target_family = "wasm")
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

#[allow(clippy::type_complexity)]
static RESOLVER_AND_TSCONFIG: OnceLock<(
    Resolver,
    Option<Arc<TsConfig>>,
    Option<&'static str>,
)> = OnceLock::new();

#[cfg(not(target_os = "windows"))]
const NODE_MODULES_PATH: &str = "/node_modules/";

#[cfg(target_os = "windows")]
const NODE_MODULES_PATH: &str = "\\node_modules\\";

#[cfg(not(target_os = "windows"))]
const PATH_PREFIX: &str = "file://";

#[cfg(target_os = "windows")]
const PATH_PREFIX: &str = "file:///";

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
pub struct Output(CodegenReturn);

#[napi]
impl Output {
    #[napi]
    /// Returns the generated code
    /// Cache the result of this function if you need to use it multiple times
    pub fn source(&self) -> String {
        self.0.code.clone()
    }

    #[napi]
    /// Returns the source map as a JSON string
    /// Cache the result of this function if you need to use it multiple times
    pub fn source_map(&self) -> Option<String> {
        self.0.map.clone().map(|s| s.to_json_string())
    }
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
        let (_, resolved_tsconfig, _) =
            RESOLVER_AND_TSCONFIG.get_or_init(|| init_resolver(cwd, vec![]));
        oxc_transform(
            src_path,
            &self.source,
            resolved_tsconfig.as_ref().map(|t| &t.compiler_options),
            Some(Module::CommonJS),
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
    pub fn new(cwd: String) -> Self {
        Self { cwd }
    }

    #[napi]
    pub fn transform(&self, path: String, source: Either<String, &[u8]>) -> Result<Output> {
        let cwd = PathBuf::from(&self.cwd);
        let (_, resolved_tsconfig, _) =
            RESOLVER_AND_TSCONFIG.get_or_init(|| init_resolver(cwd, vec![]));
        oxc_transform(
            Path::new(&path),
            &source,
            resolved_tsconfig.as_ref().map(|t| &t.compiler_options),
            Some(Module::CommonJS),
        )
    }

    #[napi]
    pub fn transform_async(
        &self,
        path: String,
        source: Either3<String, Uint8Array, Buffer>,
    ) -> AsyncTask<TransformTask> {
        AsyncTask::new(TransformTask {
            path,
            source,
            cwd: self.cwd.clone(),
        })
    }
}

fn oxc_transform<S: TryAsStr>(
    src_path: &Path,
    code: &S,
    compiler_options: Option<&'static CompilerOptions>,
    module_target: Option<Module>,
) -> Result<Output> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(src_path).unwrap_or_default();
    let source_str = code.try_as_str()?;
    let ParserReturn {
        mut program,
        errors,
        ..
    } = Parser::new(&allocator, source_str, source_type).parse();
    if !errors.is_empty() {
        let msg = join_errors(errors, source_str);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to parse {}: {}", src_path.display(), msg),
        ));
    }
    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();

    let use_define_for_class_fields = compiler_options
        .and_then(|c| c.use_define_for_class_fields)
        .unwrap_or_default();
    let TransformerReturn { errors, .. } = Transformer::new(
        &allocator,
        src_path,
        &TransformOptions {
            assumptions: CompilerAssumptions {
                set_public_class_fields: use_define_for_class_fields,
                ..Default::default()
            },
            decorator: DecoratorOptions {
                legacy: compiler_options
                    .and_then(|c| c.experimental_decorators)
                    .unwrap_or(false),
                emit_decorator_metadata: compiler_options
                    .and_then(|c| c.emit_decorator_metadata)
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
                jsx_pragma: compiler_options
                    .and_then(|c| c.jsx_factory.as_deref())
                    .map(Cow::Borrowed)
                    .unwrap_or_default(),
                jsx_pragma_frag: compiler_options
                    .and_then(|c| c.jsx_fragment_factory.as_ref())
                    .map(|c| Cow::Borrowed(c.as_str()))
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
                },
                ..Default::default()
            },
            proposals: ProposalOptions {
                explicit_resource_management: true,
            },
            helper_loader: HelperLoaderOptions {
                module_name: Cow::Borrowed("@oxc-node/core"),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .build_with_scoping(scoping, &mut program);

    if !errors.is_empty() {
        let msg = join_errors(errors, source_str);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to transform {}: {}", src_path.display(), msg),
        ));
    }

    Ok(Output(
        Codegen::new()
            .with_options(CodegenOptions {
                source_map_path: Some(src_path.to_path_buf()),
                ..Default::default()
            })
            .build(&program),
    ))
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

#[cfg_attr(
    not(target_family = "wasm"),
    napi(object, object_from_js = false, object_to_js = false)
)]
#[cfg_attr(target_family = "wasm", napi(object, object_to_js = false))]
pub struct OxcResolveOptions {
    pub get_current_directory: Option<FunctionRef<(), String>>,
}

#[cfg(not(target_family = "wasm"))]
impl FromNapiValue for OxcResolveOptions {
    unsafe fn from_napi_value(_: sys::napi_env, _value: sys::napi_value) -> Result<Self> {
        Ok(OxcResolveOptions {
            get_current_directory: None,
        })
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

    let (resolver, tsconfig, default_module_resolved_from_tsconfig) =
        RESOLVER_AND_TSCONFIG.get_or_init(|| init_resolver(cwd.clone(), conditions.to_vec()));

    let is_absolute_path = specifier.starts_with(PATH_PREFIX);

    let directory = {
        if let Some(parent) = context.parent_url.as_deref() {
            if let Some(parent) = parent
                .strip_prefix(PATH_PREFIX)
                .and_then(|p| Path::new(p).parent())
            {
                tracing::debug!(directory = ?parent);
                Ok(parent)
            } else {
                Err(Error::new(
                    Status::GenericFailure,
                    "Parent URL is not a file URL",
                ))
            }
        } else {
            Ok(cwd.as_path())
        }
    }?;

    let resolution = resolver.resolve(
        if is_absolute_path {
            Path::new("/")
        } else {
            directory
        },
        if is_absolute_path {
            specifier.strip_prefix(PATH_PREFIX).unwrap()
        } else {
            &specifier
        },
    );

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
        if !p
            .to_str()
            .map(|p| p.contains(NODE_MODULES_PATH))
            .unwrap_or(false)
        {
            let format = {
                let ext = p.extension().and_then(|ext| ext.to_str());

                let format = ext
                    .and_then(|ext| match ext {
                        "cjs" | "cts" | "node" => None,
                        "mts" | "mjs" => Some("module"),
                        _ => {
                            if ext == "ts" || ext == "tsx" {
                                if let Some(default_module_resolved_from_tsconfig) =
                                    default_module_resolved_from_tsconfig
                                {
                                    return Some(default_module_resolved_from_tsconfig);
                                }
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
    let (_, tsconfig, _) = RESOLVER_AND_TSCONFIG.get().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "Failed to get resolver and tsconfig",
        )
    })?;

    let resolved_compiler_options = tsconfig.as_ref().map(|tsconfig| &tsconfig.compiler_options);
    match loaded {
        Either::A(output) => Ok(Either::A(transform_output(
            url,
            output,
            resolved_compiler_options,
        )?)),
        Either::B(promise) => promise
            .then(move |ctx| transform_output(url, ctx.value, resolved_compiler_options))
            .map(Either::B),
    }
}

fn transform_output(
    url: String,
    output: LoadFnOutput,
    resolved_compiler_options: Option<&'static CompilerOptions>,
) -> Result<LoadFnOutput> {
    match &output.source {
        Some(Either4::D(_)) | None => {
            tracing::debug!("No source code to transform {}", url);
            Ok(LoadFnOutput {
                format: output.format,
                source: None,
                response_url: Some(url),
            })
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
                None,
            )?;
            let output_code = transform_output
                .0
                .map
                .map(|sm| {
                    let sm = sm.to_data_url();
                    const SOURCEMAP_PREFIX: &str = "\n//# sourceMappingURL=";
                    let len = sm.len() + transform_output.0.code.len() + 22;
                    let mut output_code = String::with_capacity(len + 22);
                    output_code.push_str(&transform_output.0.code);
                    output_code.push_str(SOURCEMAP_PREFIX);
                    output_code.push_str(sm.as_str());
                    output_code
                })
                .unwrap_or_else(|| transform_output.0.code);
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
                Error::new(
                    Status::GenericFailure,
                    "Failed to convert Uint8Array to Vec<u8>",
                )
            }),
            Either3::C(buf) => std::str::from_utf8(buf).map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "Failed to convert Buffer to Vec<u8>",
                )
            }),
        }
    }
}

impl TryAsStr for Either4<String, Uint8Array, Buffer, Null> {
    fn try_as_str(&self) -> Result<&str> {
        match self {
            Either4::A(s) => Ok(s),
            Either4::B(arr) => std::str::from_utf8(arr).map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "Failed to convert Uint8Array to Vec<u8>",
                )
            }),
            Either4::C(buf) => std::str::from_utf8(buf).map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "Failed to convert Buffer to Vec<u8>",
                )
            }),
            Either4::D(_) => Err(Error::new(
                Status::InvalidArg,
                "Invalid value type in LoadFnOutput::source",
            )),
        }
    }
}

fn init_resolver(
    cwd: PathBuf,
    conditions: Vec<String>,
) -> (Resolver, Option<Arc<TsConfig>>, Option<&'static str>) {
    let tsconfig = env::var("TS_NODE_PROJECT")
        .or_else(|_| env::var("OXC_TSCONFIG_PATH"))
        .map(Cow::Owned)
        .unwrap_or(Cow::Borrowed("tsconfig.json"));
    tracing::debug!(tsconfig = ?tsconfig);
    let tsconfig_full_path = if !tsconfig.starts_with('/') {
        cwd.join(PathBuf::from(&*tsconfig))
    } else {
        PathBuf::from(&*tsconfig)
    };
    tracing::debug!(tsconfig_full_path = ?tsconfig_full_path);
    let tsconfig = fs::exists(&tsconfig_full_path)
        .unwrap_or(false)
        .then_some(TsconfigOptions {
            config_file: tsconfig_full_path.clone(),
            references: TsconfigReferences::Auto,
        });
    let resolver = Resolver::new(ResolveOptions {
        tsconfig,
        condition_names: conditions,
        extension_alias: vec![
            (
                ".js".to_owned(),
                vec![".js".to_owned(), ".ts".to_owned(), ".tsx".to_owned()],
            ),
            (
                ".mjs".to_owned(),
                vec![".mjs".to_owned(), ".mts".to_owned()],
            ),
            (
                ".cjs".to_owned(),
                vec![".cjs".to_owned(), ".cts".to_owned()],
            ),
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

    let tsconfig = resolver.resolve_tsconfig(tsconfig_full_path).ok();

    tracing::debug!(tsconfig = ?tsconfig);

    let default_module_resolved_from_tsconfig = if let Some(tsconfig) = tsconfig.as_ref() {
        if matches!(
            tsconfig
                .compiler_options
                .module
                .as_deref()
                .map(|m| m.to_ascii_lowercase())
                .as_deref(),
            Some("nodenext")
                | Some("node16")
                | Some("node18")
                | Some("es6")
                | Some("es2015")
                | Some("es2020")
                | Some("es2022")
                | Some("esnext")
        ) {
            Some("module")
        } else {
            None
        }
    } else {
        None
    };

    (resolver, tsconfig, default_module_resolved_from_tsconfig)
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
