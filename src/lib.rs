use std::{
    borrow::Cow,
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use oxc::{
    allocator::Allocator,
    codegen::{CodeGenerator, CodegenReturn},
    parser::{Parser, ParserReturn},
    span::SourceType,
    transformer::{Transformer, TransformerReturn},
};
use oxc_resolver::{ResolveOptions, Resolver, TsconfigOptions, TsconfigReferences};
use phf::Set;

#[cfg(all(not(target_arch = "arm"), not(target_family = "wasm")))]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

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

static RESOLVER: OnceLock<Resolver> = OnceLock::new();

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

#[cfg_attr(not(target_family = "wasm"), napi::module_init)]
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
        self.0.source_text.clone()
    }

    #[napi]
    /// Returns the source map as a JSON string
    /// Cache the result of this function if you need to use it multiple times
    pub fn source_map(&self) -> Option<String> {
        self.0
            .source_map
            .clone()
            .and_then(|s| s.to_json_string().ok())
    }
}

#[napi]
pub fn transform(path: String, code: String) -> Result<Output> {
    let allocator = Allocator::default();
    let src_path = Path::new(&path);
    let source_type = SourceType::from_path(src_path).unwrap_or_default();
    let ParserReturn {
        trivias,
        mut program,
        errors,
        ..
    } = Parser::new(&allocator, &code, source_type).parse();
    if !errors.is_empty() {
        for error in &errors {
            eprintln!("{}", error);
        }
        return Err(Error::new(
            Status::GenericFailure,
            "Failed to parse source file",
        ));
    }
    let TransformerReturn { errors, .. } = Transformer::new(
        &allocator,
        src_path,
        source_type,
        &code,
        trivias,
        Default::default(),
    )
    .build(&mut program);

    if !errors.is_empty() {
        for error in &errors {
            eprintln!("{}", error);
        }
        return Err(Error::new(
            Status::GenericFailure,
            "Failed to transform source file",
        ));
    }

    Ok(Output(CodeGenerator::new().build(&program)))
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
    pub format: Either3<String, Undefined, Null>,
    pub short_circuit: Option<bool>,
    pub url: String,
    pub import_attributes: Option<Either<HashMap<String, String>, Null>>,
}

#[napi(ts_return_type = "ResolveFnOutput | Promise<ResolveFnOutput>")]
pub fn resolve(
    specifier: String,
    context: ResolveContext,
    next_resolve: Function<
        (String, Option<ResolveContext>),
        Either<ResolveFnOutput, PromiseRaw<ResolveFnOutput>>,
    >,
) -> Result<Either<ResolveFnOutput, PromiseRaw<ResolveFnOutput>>> {
    tracing::debug!(specifier = ?specifier, context = ?context);
    if specifier.starts_with("node:") || specifier.starts_with("nodejs:") {
        tracing::debug!("short-circuiting builtin protocol resolve: {}", specifier);
        return Ok(Either::A(ResolveFnOutput {
            short_circuit: Some(true),
            format: Either3::A("builtin".to_string()),
            url: specifier,
            import_attributes: None,
        }));
    }
    if BUILTIN_MODULES.contains(specifier.as_str()) {
        tracing::debug!("short-circuiting builtin resolve: {}", specifier);
        return Ok(Either::A(ResolveFnOutput {
            short_circuit: Some(true),
            format: Either3::A("builtin".to_string()),
            url: format!("node:{specifier}"),
            import_attributes: None,
        }));
    }
    if specifier.starts_with("data:") {
        tracing::debug!("short-circuiting data URL resolve: {}", specifier);
        return Ok(Either::A(ResolveFnOutput {
            short_circuit: Some(true),
            format: Either3::C(Null),
            url: specifier,
            import_attributes: None,
        }));
    }

    // entrypoint
    if context.parent_url.is_none() {
        tracing::debug!("short-circuiting entrypoint resolve: {}", specifier);
        return Ok(Either::A(ResolveFnOutput {
            short_circuit: Some(true),
            format: Either3::A("module".to_owned()),
            url: specifier,
            import_attributes: None,
        }));
    }

    let add_short_circuit = |context: ResolveContext| {
        let builtin_resolved = next_resolve.call((specifier.clone(), Some(context)))?;

        match builtin_resolved {
            Either::A(mut output) => {
                output.short_circuit = Some(true);
                return Ok(Either::A(output));
            }
            Either::B(mut promise) => {
                return promise
                    .then(|mut ctx| {
                        ctx.value.short_circuit = Some(true);
                        return Ok(ctx.value);
                    })
                    .map(Either::B);
            }
        }
    };

    // import attributes
    if !context.import_attributes.is_empty() {
        tracing::debug!(
            "short-circuiting import attributes resolve: {}, attributes: {:?}",
            specifier,
            context.import_attributes
        );
        return add_short_circuit(context);
    };

    let resolver = RESOLVER.get_or_init(init_resolver);

    // parent_url.is_none() has been early returned
    let resolution = resolver.resolve(
        {
            if let Some(parent) = context
                .parent_url
                .as_deref()
                .unwrap()
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
        }?,
        &specifier,
    );

    if let Ok(resolution) = resolution {
        tracing::debug!(resolution = ?resolution, "resolved");
        let p = resolution.path();
        if !p
            .to_str()
            .map(|p| p.contains(NODE_MODULES_PATH))
            .unwrap_or(false)
        {
            return Ok(Either::A(ResolveFnOutput {
                short_circuit: Some(true),
                format: {
                    let format = if resolution
                        .package_json()
                        .and_then(|p| p.r#type.as_ref())
                        .and_then(|t| t.as_str())
                        .is_some_and(|t| t == "module")
                    {
                        "module".to_owned()
                    } else {
                        "commonjs".to_owned()
                    };
                    tracing::debug!(path = ?p, format = ?format);
                    Either3::A(format)
                },
                url: if resolution.query().is_some() || resolution.fragment().is_some() {
                    format!("{PATH_PREFIX}{}", resolution.full_path().to_string_lossy())
                } else {
                    format!("{PATH_PREFIX}{}", resolution.path().to_string_lossy())
                },
                import_attributes: Some(Either::A(context.import_attributes.clone())),
            }));
        }
    }

    tracing::debug!("default resolve: {}", specifier);

    add_short_circuit(context)
}

#[napi(object)]
#[derive(Debug)]
pub struct LoadContext {
    /// Export conditions of the relevant `package.json`
    pub conditions: Option<Vec<String>>,
    /// The format optionally supplied by the `resolve` hook chain
    pub format: String,
    /// An object whose key-value pairs represent the assertions for the module to import
    pub import_attributes: HashMap<String, String>,
}

#[napi(object)]
pub struct LoadFnOutput {
    pub format: String,
    /// A signal that this hook intends to terminate the chain of `resolve` hooks.
    pub short_circuit: Option<bool>,
    pub source: Option<Either4<String, Uint8Array, Buffer, Null>>,
}

#[napi]
pub fn load(
    url: String,
    context: LoadContext,
    next_load: Function<
        (String, Option<LoadContext>),
        Either<LoadFnOutput, PromiseRaw<LoadFnOutput>>,
    >,
) -> Result<Either<LoadFnOutput, PromiseRaw<LoadFnOutput>>> {
    tracing::debug!(url = ?url, context = ?context);
    if url.starts_with("data:")
        || context.format == "builtin"
        || context.format == "json"
        || context.format == "wasm"
    {
        tracing::debug!("short-circuiting load: {}", url);
        return next_load.call((url, Some(context)));
    }

    let loaded = next_load.call((url.clone(), Some(context)))?;
    match loaded {
        Either::A(output) => Ok(Either::A(oxc_transform(url, output)?)),
        Either::B(mut promise) => promise
            .then(move |ctx| oxc_transform(url, ctx.value))
            .map(Either::B),
    }
}

fn oxc_transform(url: String, output: LoadFnOutput) -> Result<LoadFnOutput> {
    match &output.source {
        Some(Either4::D(_)) | None => {
            tracing::debug!("No source code to transform {}", url);
            Ok(LoadFnOutput {
                format: output.format,
                short_circuit: Some(true),
                source: output.source,
            })
        }
        Some(Either4::A(_) | Either4::B(_) | Either4::C(_)) => {
            let source = output.source.as_ref().unwrap().try_as_str()?;
            let allocator = Allocator::default();
            let src_path = Path::new(&url);
            let jsx = src_path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext == "tsx" || ext == "jsx")
                .unwrap_or_default();
            tracing::debug!(url = ?url, jsx = ?jsx, src_path = ?src_path, "running oxc transform");
            let source_type = match output.format.as_str() {
                "commonjs" => SourceType::default().with_script(true).with_jsx(jsx),
                "module" => SourceType::default().with_module(true).with_jsx(jsx),
                _ => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!("Unknown module format {}", output.format),
                    ))
                }
            };
            let ParserReturn {
                trivias,
                mut program,
                errors,
                ..
            } = Parser::new(&allocator, source, source_type).parse();
            if !errors.is_empty() {
                for error in &errors {
                    eprintln!("{}", error);
                }
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse source file {}", url),
                ));
            }
            let TransformerReturn { errors, .. } = Transformer::new(
                &allocator,
                src_path,
                source_type,
                source,
                trivias,
                Default::default(),
            )
            .build(&mut program);

            if !errors.is_empty() {
                for error in &errors {
                    eprintln!("{}", error);
                }
                return Err(Error::new(
                    Status::GenericFailure,
                    "Failed to transform source file",
                ));
            }

            tracing::debug!("loaded {} format: {}", url, output.format);
            Ok(LoadFnOutput {
                format: output.format,
                short_circuit: Some(true),
                source: Some(Either4::B(Uint8Array::from_string(
                    CodeGenerator::new().build(&program).source_text,
                ))),
            })
        }
    }
}

trait TryAsStr {
    fn try_as_str(&self) -> Result<&str>;
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

fn init_resolver() -> Resolver {
    let tsconfig = env::var("TS_NODE_PROJECT")
        .or_else(|_| env::var("OXC_TSCONFIG_PATH"))
        .map(Cow::Owned)
        .unwrap_or(Cow::Borrowed("tsconfig.json"));
    tracing::debug!(tsconfig = ?tsconfig);
    let tsconfig_full_path = if !tsconfig.starts_with('/') {
        let current = env::current_dir().expect("Failed to get current directory");
        current.join(PathBuf::from(&*tsconfig))
    } else {
        PathBuf::from(&*tsconfig)
    };
    tracing::debug!(tsconfig_full_path = ?tsconfig_full_path);
    Resolver::new(ResolveOptions {
        tsconfig: Some(TsconfigOptions {
            config_file: tsconfig_full_path,
            references: TsconfigReferences::Auto,
        }),
        condition_names: vec!["node".to_owned(), "import".to_owned()],
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
        ..Default::default()
    })
}
