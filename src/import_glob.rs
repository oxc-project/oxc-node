//! `import.meta.glob`, expanded as Vite's plugin for unbundled code (`vite:import-glob`)
//! expands it: each glob call becomes an object of the matched modules.
//!
//! The pass runs on the syntax tree in [`crate::transform_program`], after the
//! TypeScript transform. The generated code is parsed from text, so it builds no node
//! by hand and has no mapping; everything else keeps its place in the source map.
//! Patterns must be relative: oxc-node has neither a project root nor aliases.
//! [`GlobSet`] matches the files, here and for the watcher ([`crate::GlobMatcher`]).

use std::{
    borrow::Cow,
    env,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use oxc::{
    allocator::{Allocator, TakeIn},
    ast::ast::{
        Argument, ArrayExpressionElement, BindingIdentifier, CallExpression, Expression,
        IdentifierReference, ImportMeta, ObjectPropertyKind, Program, PropertyKey, PropertyKind,
    },
    ast_visit::{Visit, VisitMut, walk_mut},
    diagnostics::OxcDiagnostic,
    span::{GetSpan, Span},
};

use globstar::{CompileOptions, DirMatch, Glob};

use crate::{
    WatchGlob, WatchGlobRoot, file_url_to_path, generated_expression, has_module_declaration,
    parse_generated_module, report_watch_globs, watching,
};

/// The prefix of the names eager imports bind, as in Vite.
const NAME_PREFIX: &str = "__vite_glob_";

/// Expand every glob call in `program`, the importer's syntax tree after the TypeScript
/// transform, and record the calls for the watch parent. `source` is the importer's
/// source: the spans of the errors point into it.
pub(crate) fn expand<'a>(
    allocator: &'a Allocator,
    src_path: &Path,
    program: &mut Program<'a>,
    source: &str,
) -> Result<(), Vec<OxcDiagnostic>> {
    let globs = expand_calls(allocator, src_path, program, source, watching())?;
    report_watch_globs(globs);
    Ok(())
}

/// [`expand`], returning the watch entries instead of recording them, and only when
/// `report` asks for them.
fn expand_calls<'a>(
    allocator: &'a Allocator,
    src_path: &Path,
    program: &mut Program<'a>,
    source: &str,
    report: bool,
) -> Result<Vec<WatchGlob>, Vec<OxcDiagnostic>> {
    if memchr::memmem::find(source.as_bytes(), b"glob").is_none() {
        return Ok(Vec::new());
    }
    // A `data:` URL or a custom scheme has no folder to match files in.
    let Some(importer) = importer_path(src_path) else { return Ok(Vec::new()) };
    let prefix = free_prefix(program, source);
    let mut expander = Expander {
        allocator,
        importer_dir: parent(&importer),
        importer: &importer,
        prefix,
        report,
        calls: 0,
        expanded: 0,
        other_import_metas: 0,
        imports: String::new(),
        errors: Vec::new(),
        globs: Vec::new(),
    };
    expander.visit_program(program);
    let Expander { expanded, other_import_metas, imports, errors, globs, .. } = expander;
    if !errors.is_empty() {
        return Err(errors);
    }
    // As in Vite, the eager imports come first, so the matched modules run before the
    // importer's own imports. A `#!` line and the directives stay ahead of them.
    if !imports.is_empty() {
        let imports = parse_generated_module(allocator, &imports);
        let mut body =
            oxc::allocator::Vec::with_capacity_in(imports.len() + program.body.len(), &allocator);
        body.extend(imports);
        body.extend(program.body.take_in(&allocator));
        program.body = body;
    }
    // The `pirates` path hands the output to Node.js' CommonJS loader, which decides the
    // format from syntax: a file whose only module syntax was the glob call would run as
    // CommonJS there, and as an ES module through `import`.
    if expanded > 0 && other_import_metas == 0 && !has_module_declaration(program) {
        program.body.extend(parse_generated_module(allocator, "export {};"));
    }
    Ok(globs)
}

/// The prefix of the names the eager imports bind: [`NAME_PREFIX`], with `_` added until no
/// name of the source starts with it. A name in the source text counts, also one in a string
/// that `eval` could read. A name spelled with a `\u` escape is in the text only in that
/// spelling, so then the identifiers of the syntax tree count too: the declared ones, and the
/// references that a new module binding would shadow.
fn free_prefix(program: &Program<'_>, source: &str) -> String {
    let mut names = Vec::new();
    if memchr::memmem::find(source.as_bytes(), b"\\u").is_some() {
        let mut scan = NameScan { names: &mut names };
        scan.visit_program(program);
    }
    let mut prefix = NAME_PREFIX.to_owned();
    while memchr::memmem::find(source.as_bytes(), prefix.as_bytes()).is_some()
        || names.iter().any(|name| name.starts_with(&prefix))
    {
        prefix.push('_');
    }
    prefix
}

/// The identifiers of a program that start with [`NAME_PREFIX`].
struct NameScan<'n> {
    names: &'n mut Vec<String>,
}

impl NameScan<'_> {
    fn note(&mut self, name: &str) {
        if name.starts_with(NAME_PREFIX) {
            self.names.push(name.to_owned());
        }
    }
}

impl<'a> Visit<'a> for NameScan<'_> {
    fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
        self.note(it.name.as_str());
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        self.note(it.name.as_str());
    }
}

/// What a glob call is replaced with.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Form {
    /// The call itself: `Object.assign({ key: value })`.
    Map,
    /// The argument of `Object.keys()`: `{ key: 0 }`, which imports nothing.
    Keys,
    /// The argument of `Object.values()`: `[value]`.
    Values,
}

struct Expander<'a, 'i> {
    allocator: &'a Allocator,
    /// The importer, absolute and with `/`.
    importer: &'i str,
    importer_dir: &'i str,
    /// [`NAME_PREFIX`], with `_` added until the source does not contain it.
    prefix: String,
    /// Whether to build the watch entries.
    report: bool,
    /// The glob calls seen so far, in source order.
    calls: usize,
    expanded: usize,
    /// The `import.meta` expressions that are not the callee of an expanded call.
    other_import_metas: usize,
    /// The eager import statements, in call order.
    imports: String,
    errors: Vec<OxcDiagnostic>,
    globs: Vec<WatchGlob>,
}

impl<'a> VisitMut<'a> for Expander<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::CallExpression(call) = expression {
            if is_glob_call(call) {
                if let Some(replacement) = self.expand_call(call, Form::Map) {
                    *expression = replacement;
                }
                return;
            }
            if let Some(form) = keys_or_values(call)
                && let Some(Argument::CallExpression(glob)) = call.arguments.first()
                && is_glob_call(glob)
            {
                if let Some(replacement) = self.expand_call(glob, form) {
                    call.arguments[0] = Argument::from(replacement);
                }
                for argument in call.arguments.iter_mut().skip(1) {
                    self.visit_argument(argument);
                }
                return;
            }
        }
        walk_mut::walk_expression(self, expression);
    }

    fn visit_import_meta(&mut self, _it: &mut ImportMeta) {
        self.other_import_metas += 1;
    }
}

/// `import.meta.glob(...)`: a call that is not optional, of the static member `glob` of
/// `import.meta`, with no parentheses around the callee.
fn is_glob_call(call: &CallExpression<'_>) -> bool {
    !call.optional
        && matches!(&call.callee, Expression::StaticMemberExpression(member)
            if !member.optional
                && member.property.name.as_str() == "glob"
                && matches!(member.object, Expression::ImportMeta(_)))
}

/// The form for the first argument of `Object.keys()` or `Object.values()`.
fn keys_or_values(call: &CallExpression<'_>) -> Option<Form> {
    let Expression::StaticMemberExpression(member) = &call.callee else { return None };
    let Expression::Identifier(object) = &member.object else { return None };
    if object.name.as_str() != "Object" {
        return None;
    }
    match member.property.name.as_str() {
        "keys" => Some(Form::Keys),
        "values" => Some(Form::Values),
        _ => None,
    }
}

impl<'a> Expander<'a, '_> {
    /// The replacement for one glob call, or `None` after an error.
    fn expand_call(&mut self, call: &CallExpression<'a>, form: Form) -> Option<Expression<'a>> {
        let index = self.calls;
        self.calls += 1;
        let GlobCall { patterns, options } = match parse_call(call) {
            Ok(glob) => glob,
            Err(errors) => {
                self.errors.extend(errors);
                return None;
            }
        };
        // Nothing is emitted once a call has failed; the rest are only checked.
        if !self.errors.is_empty() {
            return None;
        }
        let dir = match &options.base {
            Some((base, _)) => join(self.importer_dir, base),
            None => self.importer_dir.to_owned(),
        };
        let mut include = Vec::new();
        let mut exclude = Vec::new();
        let mut roots = Vec::new();
        for (pattern, _) in &patterns {
            let (negative, pattern) = match pattern.strip_prefix('!') {
                Some(negative) => (true, negative),
                None => (false, pattern.as_str()),
            };
            for pattern in translate(pattern) {
                if negative && pattern.starts_with("**") {
                    exclude.push(pattern);
                } else if negative {
                    exclude.push(resolve(&dir, &pattern).pattern);
                } else {
                    let resolved = resolve(&dir, &pattern);
                    include.push(resolved.pattern);
                    roots.push(WatchGlobRoot { base: resolved.dir, depth: resolved.depth });
                }
            }
        }
        let nocase = options.case_sensitive == Some(false);
        let set = GlobSet::from_patterns(&include, &exclude, options.exhaustive, nocase);
        let mut files = Vec::new();
        let mut walked: Vec<&WatchGlobRoot> = Vec::new();
        for root in &roots {
            if !walked.contains(&root) {
                walk(&root.base, root.depth, options.exhaustive, &set, &mut files);
                walked.push(root);
            }
        }
        files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        files.dedup();
        if self.report && !include.is_empty() {
            self.globs.push(WatchGlob {
                roots,
                include,
                exclude: (!exclude.is_empty()).then_some(exclude),
                dot: options.exhaustive.then_some(true),
                nocase: nocase.then_some(true),
                files: Some(files.clone()),
            });
        }
        files.retain(|file| file != self.importer);
        let text = self.generate(index, form, &dir, &options, &files);
        self.expanded += 1;
        let expression = generated_expression(self.allocator, &text);
        Some(match expression {
            // `({ ... })`: an object at the start of a statement needs them.
            Expression::ParenthesizedExpression(parenthesized) => parenthesized.unbox().expression,
            expression => expression,
        })
    }

    /// The source of the replacement, Vite's shape. The eager imports go to `imports`.
    fn generate(
        &mut self,
        index: usize,
        form: Form,
        dir: &str,
        options: &GlobOptions,
        files: &[String],
    ) -> String {
        let import = options.import.as_deref().filter(|name| *name != "*");
        let mut entries = Vec::with_capacity(files.len());
        for (i, file) in files.iter().enumerate() {
            let path = relative_import(self.importer_dir, file);
            let key =
                if options.base.is_some() { relative_import(dir, file) } else { path.clone() };
            if form == Form::Keys {
                entries.push(format!("{}: 0", json(&key)));
                continue;
            }
            // The key is the path; the specifier is a URL, which Node.js decodes.
            let specifier = json(&url_specifier(&path));
            let value = if options.eager {
                let name = format!("{}{index}_{i}", self.prefix);
                let _ = match import {
                    Some(export) => writeln!(
                        self.imports,
                        "import {{ {} as {name} }} from {specifier};",
                        export_name(export),
                    ),
                    None => writeln!(self.imports, "import * as {name} from {specifier};"),
                };
                name
            } else {
                match import {
                    Some(export) => {
                        format!("() => import({specifier}).then((m) => m[{}])", json(export))
                    }
                    None => format!("() => import({specifier})"),
                }
            };
            entries.push(match form {
                Form::Values => value,
                _ => format!("{}: {value}", json(&key)),
            });
        }
        let entries = entries.join(", ");
        match form {
            Form::Map => format!("Object.assign({{{entries}}})"),
            Form::Keys => format!("({{{entries}}})"),
            Form::Values => format!("[{entries}]"),
        }
    }
}

/// A JSON string literal, which is a JavaScript one too.
fn json(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// A relative path as a relative URL: a specifier of `import` is a URL, so `%` would start an
/// escape, `#` a fragment and `?` a query, and the URL parser reads `\` as `/` and drops tabs
/// and line breaks. These are percent-encoded, as `pathToFileURL` encodes them; everything
/// else the URL parser keeps or encodes itself, and Node.js decodes it back to the path. A
/// file with a glob call stays an ES module, so its imports never become `require()` calls,
/// which take paths.
fn url_specifier(path: &str) -> Cow<'_, str> {
    if !path.contains(['%', '#', '?', '\\', '\t', '\n', '\r']) {
        return Cow::Borrowed(path);
    }
    let mut encoded = String::with_capacity(path.len() + 8);
    for char in path.chars() {
        match char {
            '%' => encoded.push_str("%25"),
            '#' => encoded.push_str("%23"),
            '?' => encoded.push_str("%3F"),
            '\\' => encoded.push_str("%5C"),
            '\t' => encoded.push_str("%09"),
            '\n' => encoded.push_str("%0A"),
            '\r' => encoded.push_str("%0D"),
            char => encoded.push(char),
        }
    }
    Cow::Owned(encoded)
}

/// The name in `import { name as local }`: a string for anything but an identifier name.
fn export_name(name: &str) -> String {
    if oxc::syntax::identifier::is_identifier_name(name) { name.to_owned() } else { json(name) }
}

/// The arguments of a glob call that passed every check.
struct GlobCall {
    /// Each pattern as written, and its span.
    patterns: Vec<(String, Span)>,
    options: GlobOptions,
}

#[derive(Default)]
struct GlobOptions {
    eager: bool,
    import: Option<String>,
    exhaustive: bool,
    base: Option<(String, Span)>,
    case_sensitive: Option<bool>,
}

fn syntax_error(message: &str, span: Span) -> OxcDiagnostic {
    OxcDiagnostic::error(format!("Invalid glob import syntax: {message}")).with_label(span)
}

fn not_static(span: Span) -> OxcDiagnostic {
    OxcDiagnostic::error("Unable to parse the glob options as the value is not static")
        .with_label(span)
}

fn invalid_glob(glob: &str, reason: &str, span: Span) -> OxcDiagnostic {
    OxcDiagnostic::error(format!(
        "Invalid glob: \"{glob}\". oxc-node {reason}, so the glob must start with './' or '../'"
    ))
    .with_label(span)
}

const NO_ROOT: &str = "has no project root";
const NO_ALIASES: &str = "resolves no aliases in globs";

/// The patterns and options of a glob call, or every error in them.
fn parse_call(call: &CallExpression<'_>) -> Result<GlobCall, Vec<OxcDiagnostic>> {
    let count = call.arguments.len();
    if !(1..=2).contains(&count) {
        return Err(vec![syntax_error(
            &format!("Expected 1-2 arguments, but got {count}"),
            call.span,
        )]);
    }
    let mut errors = Vec::new();
    let mut patterns = Vec::new();
    let mut pattern = |expression: Option<&Expression<'_>>, span: Span| match expression {
        Some(expression) => match pattern_literal(expression) {
            Ok(found) => patterns.push(found),
            Err(error) => errors.push(error),
        },
        // A spread element.
        None => errors.push(syntax_error("Could only use literals", span)),
    };
    match &call.arguments[0] {
        Argument::ArrayExpression(array) => {
            for element in &array.elements {
                // A hole.
                if matches!(element, ArrayExpressionElement::Elision(_)) {
                    continue;
                }
                pattern(element.as_expression(), element.span());
            }
        }
        argument => pattern(argument.as_expression(), argument.span()),
    }
    let options = match call.arguments.get(1) {
        Some(argument) => parse_options(argument, &mut errors),
        None => GlobOptions::default(),
    };
    if let Some((base, span)) = &options.base {
        if base.starts_with('!') {
            errors.push(
                OxcDiagnostic::error("Option \"base\" cannot start with \"!\"").with_label(*span),
            );
        } else if base.starts_with('/') {
            errors.push(invalid_glob(base, NO_ROOT, *span));
        } else if !is_relative(base) {
            errors.push(invalid_glob(base, NO_ALIASES, *span));
        }
    }
    for (glob, span) in &patterns {
        let (negative, body) = match glob.strip_prefix('!') {
            Some(body) => (true, body),
            None => (false, glob.as_str()),
        };
        // A negative `**` pattern stays as written: it matches anywhere.
        if is_relative(body) || (negative && body.starts_with("**")) {
            continue;
        }
        // Vite resolves these from its root; a positive `**` there walks from `/`.
        let reason =
            if body.starts_with('/') || body.starts_with("**") { NO_ROOT } else { NO_ALIASES };
        errors.push(invalid_glob(glob, reason, *span));
    }
    if errors.is_empty() { Ok(GlobCall { patterns, options }) } else { Err(errors) }
}

fn is_relative(path: &str) -> bool {
    path.starts_with("./") || path.starts_with("../")
}

/// A pattern: a string, or a template without expressions, by its raw text.
fn pattern_literal(expression: &Expression<'_>) -> Result<(String, Span), OxcDiagnostic> {
    let not_string = |kind: &str, span: Span| {
        syntax_error(&format!("Expected glob to be a string, but got \"{kind}\""), span)
    };
    match expression {
        Expression::StringLiteral(string) => match string.value.as_str() {
            Some(value) => Ok((value.to_owned(), string.span)),
            None => Err(syntax_error("Could only use literals", string.span)),
        },
        Expression::TemplateLiteral(template) => match template.quasis.first() {
            Some(quasi) if template.expressions.is_empty() => {
                Ok((quasi.value.raw.as_str().to_owned(), template.span))
            }
            _ => Err(syntax_error(
                "Expected glob to be a string, but got dynamic template literal",
                template.span,
            )),
        },
        Expression::NumericLiteral(literal) => Err(not_string("number", literal.span)),
        Expression::BooleanLiteral(literal) => Err(not_string("boolean", literal.span)),
        Expression::BigIntLiteral(literal) => Err(not_string("bigint", literal.span)),
        Expression::NullLiteral(literal) => Err(not_string("object", literal.span)),
        Expression::RegExpLiteral(literal) => Err(not_string("object", literal.span)),
        expression => Err(syntax_error("Could only use literals", expression.span())),
    }
}

/// An option value that is a literal.
enum Literal {
    String(String),
    Boolean(bool),
    /// Another literal, by its `typeof`.
    Other(&'static str),
}

impl Literal {
    fn of(expression: &Expression<'_>) -> Option<Self> {
        Some(match expression {
            Expression::StringLiteral(string) => Self::String(string.value.as_str()?.to_owned()),
            Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
                let value = &template.quasis.first()?.value;
                let cooked = value.cooked.and_then(|cooked| cooked.as_str());
                Self::String(cooked.unwrap_or(value.raw.as_str()).to_owned())
            }
            Expression::BooleanLiteral(literal) => Self::Boolean(literal.value),
            Expression::NumericLiteral(_) => Self::Other("number"),
            Expression::BigIntLiteral(_) => Self::Other("bigint"),
            Expression::NullLiteral(_) | Expression::RegExpLiteral(_) => Self::Other("object"),
            _ => return None,
        })
    }

    fn type_name(&self) -> &'static str {
        match self {
            Self::String(_) => "string",
            Self::Boolean(_) => "boolean",
            Self::Other(kind) => kind,
        }
    }
}

/// The options object of a glob call. Vite evaluates it; this reads literals only.
fn parse_options(argument: &Argument<'_>, errors: &mut Vec<OxcDiagnostic>) -> GlobOptions {
    let mut options = GlobOptions::default();
    let Argument::ObjectExpression(object) = argument else {
        errors.push(syntax_error(
            "Expected the second argument to be an object literal",
            argument.span(),
        ));
        return options;
    };
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            errors.push(not_static(property.span()));
            continue;
        };
        if property.computed
            || property.shorthand
            || property.method
            || !matches!(property.kind, PropertyKind::Init)
        {
            errors.push(not_static(property.span));
            continue;
        }
        let key = match &property.key {
            PropertyKey::StaticIdentifier(identifier) => identifier.name.as_str().to_owned(),
            PropertyKey::StringLiteral(string) => match string.value.as_str() {
                Some(value) => value.to_owned(),
                None => {
                    errors.push(not_static(property.span));
                    continue;
                }
            },
            PropertyKey::NumericLiteral(number) => number.value.to_string(),
            _ => {
                errors.push(not_static(property.span));
                continue;
            }
        };
        if key == "query" || key == "as" {
            errors.push(
                OxcDiagnostic::error(format!(
                    "Glob option \"{key}\" is not supported: Node.js loads each matched file as \
                     a module, without import queries"
                ))
                .with_label(property.span),
            );
            continue;
        }
        let Some(value) = Literal::of(&property.value) else {
            errors.push(not_static(property.span));
            continue;
        };
        let expected = match key.as_str() {
            "eager" | "exhaustive" | "caseSensitive" => "boolean",
            "import" | "base" => "string",
            _ => {
                errors.push(
                    OxcDiagnostic::error(format!("Unknown glob option \"{key}\""))
                        .with_label(property.key.span()),
                );
                continue;
            }
        };
        match (key.as_str(), value) {
            ("eager", Literal::Boolean(value)) => options.eager = value,
            ("exhaustive", Literal::Boolean(value)) => options.exhaustive = value,
            ("caseSensitive", Literal::Boolean(value)) => options.case_sensitive = Some(value),
            ("import", Literal::String(value)) => options.import = Some(value),
            ("base", Literal::String(value)) => options.base = Some((value, property.value.span())),
            (_, value) => errors.push(
                OxcDiagnostic::error(format!(
                    "Expected glob option \"{key}\" to be of type {expected}, but got {}",
                    value.type_name()
                ))
                .with_label(property.value.span()),
            ),
        }
    }
    options
}

/// The importer as an absolute, normalized path with `/`, or `None` when `src_path` is
/// not a file: a `data:` URL or a custom scheme. The load hook passes a `file:` URL.
fn importer_path(src_path: &Path) -> Option<String> {
    let text = src_path.to_str()?;
    let path = if text.starts_with("file:") {
        file_url_to_path(text)?
    } else if is_url(text) {
        return None;
    } else if src_path.is_absolute() {
        src_path.to_path_buf()
    } else {
        env::current_dir().ok()?.join(src_path)
    };
    if !path.is_absolute() {
        return None;
    }
    let text = path.to_str()?;
    let text: Cow<'_, str> =
        if cfg!(windows) { Cow::Owned(text.replace('\\', "/")) } else { Cow::Borrowed(text) };
    Some(normalize(&text))
}

/// Whether `text` starts with a URL scheme of two characters or more: one letter is a
/// Windows drive.
fn is_url(text: &str) -> bool {
    text.find(':').is_some_and(|colon| {
        colon >= 2
            && text[..colon].bytes().enumerate().all(|(at, byte)| {
                byte.is_ascii_alphabetic()
                    || (at > 0 && (byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.')))
            })
    })
}

/// The length of the root of a path with `/`: `/`, `C:/` or `//server/share/`, and 0
/// for a relative path.
fn root_len(path: &str) -> usize {
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        return 3;
    }
    if path.starts_with("//") {
        // The server and the share belong to the root.
        return bytes
            .iter()
            .enumerate()
            .skip(2)
            .filter(|(_, byte)| **byte == b'/')
            .nth(1)
            .map_or(path.len(), |(at, _)| at + 1);
    }
    usize::from(path.starts_with('/'))
}

/// A path with `/`, with no `.`, empty, or resolvable `..` segment, as `path.posix.normalize`
/// makes it. It ends with `/` only when it is a root.
fn normalize(path: &str) -> String {
    let root = &path[..root_len(path)];
    let mut parts: Vec<&str> = Vec::new();
    for part in path[root.len()..].split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if root.is_empty() {
                    parts.push("..");
                }
            }
            part => parts.push(part),
        }
    }
    let mut normalized = String::with_capacity(path.len());
    normalized.push_str(root);
    if !root.is_empty() && !root.ends_with('/') {
        normalized.push('/');
    }
    normalized.push_str(&parts.join("/"));
    if normalized.is_empty() {
        normalized.push('.');
    }
    normalized
}

/// `relative` joined to the folder `dir`, normalized.
fn join(dir: &str, relative: &str) -> String {
    if dir.ends_with('/') {
        normalize(&format!("{dir}{relative}"))
    } else {
        normalize(&format!("{dir}/{relative}"))
    }
}

/// The folder of a normalized absolute path.
fn parent(path: &str) -> &str {
    let root = root_len(path);
    match path[root..].rfind('/') {
        Some(at) => &path[..root + at],
        None => &path[..root],
    }
}

/// `to` relative to the folder `from`, both normalized and absolute.
fn relative(from: &str, to: &str) -> String {
    let (from_root, to_root) = (&from[..root_len(from)], &to[..root_len(to)]);
    if from_root != to_root {
        return to.to_owned();
    }
    let segments = |path: &'_ str, root: usize| -> Vec<String> {
        path[root..].split('/').filter(|part| !part.is_empty()).map(str::to_owned).collect()
    };
    let from = segments(from, from_root.len());
    let to = segments(to, to_root.len());
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(to[common..].iter().map(String::as_str));
    parts.join("/")
}

/// `file` as an import from the folder `dir`: relative, starting with `./` or `../`.
fn relative_import(dir: &str, file: &str) -> String {
    let path = relative(dir, file);
    if is_relative(&path) { path } else { format!("./{path}") }
}

/// The characters that are glob syntax, unless escaped with `\`.
const GLOB_CHARS: &[u8] = b"*?[]{}";

/// The byte index of the first glob character that no `\` escapes.
fn first_glob_char(pattern: &str) -> Option<usize> {
    let bytes = pattern.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            byte if GLOB_CHARS.contains(&byte) => return Some(at),
            _ => at += 1,
        }
    }
    None
}

/// `text` without the `\` of its escapes.
fn unescape(text: &str) -> String {
    let mut unescaped = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(char) = chars.next() {
        match char {
            '\\' => unescaped.extend(chars.next()),
            char => unescaped.push(char),
        }
    }
    unescaped
}

/// `text` with its glob characters and `\` escaped, to match literally.
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for char in text.chars() {
        if matches!(char, '\\' | '*' | '?' | '[' | ']' | '{' | '}') {
            escaped.push('\\');
        }
        escaped.push(char);
    }
    escaped
}

/// `pattern` in `globstar`'s syntax, for the `picomatch` forms that Vite's glob reads and
/// `globstar` does not:
///
/// - A group `(a|b)` is `{a,b}`, and `(a)` is `a`. `picomatch` also matches a path that
///   equals the pattern's text, so a pattern whose only glob syntax is a group also gets
///   its literal text: `./(auth)/x.ts` matches the folder `(auth)` too.
/// - A range of two characters, `{1..3}` or `{c..a}`, is the class `[1-3]` or `[a-c]`, its
///   step ignored, as `picomatch` reads it. Other ranges match nothing, there too.
/// - A POSIX class in a bracket, `[[:digit:]]`, is its ranges, `[0-9]`.
fn translate(pattern: &str) -> Vec<String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut translated = String::with_capacity(pattern.len());
    rewrite(&chars, false, &mut translated);
    let literal =
        translated != pattern && first_glob_char(pattern).is_none() && chars.contains(&'(');
    if literal { vec![translated, pattern.to_owned()] } else { vec![translated] }
}

/// Write `chars` to `out` in `globstar`'s syntax. `in_group`: `chars` is an alternative of a
/// group, now a brace, so its own `,` is escaped.
fn rewrite(chars: &[char], in_group: bool, out: &mut String) {
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '\\' => {
                out.push('\\');
                out.extend(chars.get(at + 1));
                at += 2;
                continue;
            }
            '[' => {
                if let Some(end) = class_end(chars, at) {
                    rewrite_class(&chars[at..=end], out);
                    at = end + 1;
                    continue;
                }
            }
            '(' => {
                if let Some(end) = closing(chars, at, '(', ')') {
                    let alternatives = split_alternatives(&chars[at + 1..end]);
                    if let [only] = alternatives.as_slice() {
                        rewrite(only, in_group, out);
                    } else {
                        out.push('{');
                        for (index, alternative) in alternatives.iter().enumerate() {
                            if index > 0 {
                                out.push(',');
                            }
                            rewrite(alternative, true, out);
                        }
                        out.push('}');
                    }
                    at = end + 1;
                    continue;
                }
            }
            '{' => {
                if let Some(end) = closing(chars, at, '{', '}') {
                    let body = &chars[at + 1..end];
                    if let Some(class) = range_class(body) {
                        out.push_str(&class);
                    } else {
                        out.push('{');
                        rewrite(body, false, out);
                        out.push('}');
                    }
                    at = end + 1;
                    continue;
                }
            }
            ',' if in_group => {
                out.push_str("\\,");
                at += 1;
                continue;
            }
            _ => {}
        }
        out.push(chars[at]);
        at += 1;
    }
}

/// The index of the `]` that closes the bracket at `start`: a `]` right after `[`, `[!` or
/// `[^` is literal, and `[:name:]` is skipped whole.
fn class_end(chars: &[char], start: usize) -> Option<usize> {
    let mut at = start + 1;
    if matches!(chars.get(at), Some('!' | '^')) {
        at += 1;
    }
    if chars.get(at) == Some(&']') {
        at += 1;
    }
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 2,
            '[' if chars.get(at + 1) == Some(&':') => {
                let name_end = (at + 2..chars.len().saturating_sub(1))
                    .find(|&end| chars[end] == ':' && chars[end + 1] == ']');
                at = name_end.map_or(at + 1, |end| end + 2);
            }
            ']' => return Some(at),
            _ => at += 1,
        }
    }
    None
}

/// A bracket, `[` to `]`, with each POSIX class it names written as ranges. An unknown name
/// stays, and matches nothing.
fn rewrite_class(class: &[char], out: &mut String) {
    let mut at = 0;
    while at < class.len() {
        if class[at] == '\\' {
            out.push('\\');
            out.extend(class.get(at + 1));
            at += 2;
            continue;
        }
        if at > 0 && class[at] == '[' && class.get(at + 1) == Some(&':') {
            let name_end = (at + 2..class.len().saturating_sub(1))
                .find(|&end| class[end] == ':' && class[end + 1] == ']');
            if let Some(end) = name_end {
                let name: String = class[at + 2..end].iter().collect();
                if let Some(ranges) = posix_class(&name) {
                    out.push_str(ranges);
                    at = end + 2;
                    continue;
                }
            }
        }
        out.push(class[at]);
        at += 1;
    }
}

/// The ranges of a POSIX class, as `picomatch` defines them.
fn posix_class(name: &str) -> Option<&'static str> {
    Some(match name {
        "alnum" => "a-zA-Z0-9",
        "alpha" => "a-zA-Z",
        "blank" => " \t",
        "digit" => "0-9",
        "lower" => "a-z",
        "space" => " \t\r\n\u{b}\u{c}",
        "upper" => "A-Z",
        "word" => "A-Za-z0-9_",
        "xdigit" => "A-Fa-f0-9",
        _ => return None,
    })
}

/// The index of the `close` that ends the `open` at `start`, past escapes and brackets.
fn closing(chars: &[char], start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0;
    let mut at = start;
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 1,
            '[' => {
                if let Some(end) = class_end(chars, at) {
                    at = end;
                }
            }
            char if char == open => depth += 1,
            char if char == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => {}
        }
        at += 1;
    }
    None
}

/// The parts of a group's body between its own `|`.
fn split_alternatives(body: &[char]) -> Vec<&[char]> {
    let mut alternatives = Vec::new();
    let mut depth = 0usize;
    let mut from = 0;
    let mut at = 0;
    while at < body.len() {
        match body[at] {
            '\\' => at += 1,
            '[' => {
                if let Some(end) = class_end(body, at) {
                    at = end;
                }
            }
            '(' | '{' => depth += 1,
            ')' | '}' => depth = depth.saturating_sub(1),
            '|' if depth == 0 => {
                alternatives.push(&body[from..at]);
                from = at + 1;
            }
            _ => {}
        }
        at += 1;
    }
    alternatives.push(&body[from..]);
    alternatives
}

/// `[x-y]` for a brace body `x..y` or `x..y..step` whose ends are two digits, or two letters
/// of the same case.
fn range_class(body: &[char]) -> Option<String> {
    let [start, '.', '.', end, rest @ ..] = body else { return None };
    let step = match rest {
        [] => true,
        ['.', '.', step @ ..] => {
            let digits = step.strip_prefix(&['-']).unwrap_or(step);
            !digits.is_empty() && digits.iter().all(char::is_ascii_digit)
        }
        _ => false,
    };
    let same_kind = (start.is_ascii_digit() && end.is_ascii_digit())
        || (start.is_ascii_lowercase() && end.is_ascii_lowercase())
        || (start.is_ascii_uppercase() && end.is_ascii_uppercase());
    if !step || !same_kind {
        return None;
    }
    let (low, high) = if start <= end { (start, end) } else { (end, start) };
    Some(format!("[{low}-{high}]"))
}

/// A relative pattern joined to its folder.
struct Resolved {
    /// The folder before the first glob character, literal.
    dir: String,
    /// `dir` escaped, `/`, and the rest of the pattern.
    pattern: String,
    /// The levels below `dir` the pattern reaches, or `None` for any number.
    depth: Option<u32>,
}

/// `pattern`, which starts with `./` or `../`, joined to the folder `dir`. Glob characters
/// in `dir`, and in the folders the pattern names before its first glob character, are
/// literal.
fn resolve(dir: &str, pattern: &str) -> Resolved {
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    let head = first_glob_char(pattern).map_or(pattern, |at| &pattern[..at]);
    let (literal, rest) = match head.rfind('/') {
        Some(at) => (&pattern[..at], &pattern[at + 1..]),
        None => ("", pattern),
    };
    let dir = if literal.is_empty() { dir.to_owned() } else { join(dir, &unescape(literal)) };
    let depth = (!rest.contains("**") && !rest.contains('{'))
        .then(|| u32::try_from(rest.split('/').count()).unwrap_or(u32::MAX));
    let mut glob = escape(&dir);
    if !glob.ends_with('/') {
        glob.push('/');
    }
    glob.push_str(rest);
    Resolved { dir, pattern: glob, depth }
}

/// The patterns of one glob call, and the rules that both the transform and the watcher
/// match files with ([`crate::GlobMatcher`]), so the two cannot disagree.
pub(crate) struct GlobSet {
    include: Vec<Pattern>,
    exclude: Vec<Pattern>,
    /// `exhaustive`: no name is hidden.
    dot: bool,
    nocase: bool,
}

struct Pattern {
    /// `None` for a pattern that `globstar` rejects: it matches nothing.
    glob: Option<Glob>,
    /// The folder before the first glob character, unescaped; lower-case with `nocase`.
    dir: String,
}

impl Pattern {
    /// `dot` is `globstar`'s: a wildcard takes a name that starts with `.` only with it, and
    /// a segment of the pattern that spells the `.` takes such a name in any case, as in
    /// `picomatch`. Case is folded by lower-casing the pattern and the path, so that it
    /// covers more than ASCII, as `picomatch`'s `nocase` does.
    fn new(glob: &str, dot: bool, nocase: bool) -> Self {
        let glob = if nocase { glob.to_lowercase() } else { glob.to_owned() };
        let head = unescape(first_glob_char(&glob).map_or(glob.as_str(), |at| &glob[..at]));
        let dir = head.rfind('/').map_or_else(String::new, |at| head[..at].to_owned());
        let glob = Glob::new_with(&glob, CompileOptions::default().dot(dot)).ok();
        Self { glob, dir }
    }

    fn matches(&self, path: &str) -> bool {
        self.glob.as_ref().is_some_and(|glob| glob.is_match(path.as_bytes()))
    }

    /// Vite ignores `**/node_modules/**` unless `exhaustive`; here only below the folder of
    /// the pattern, so that a pattern that names a `node_modules` folder still lists it.
    fn outside_node_modules(&self, path: &str) -> bool {
        let below = path.strip_prefix(self.dir.as_str()).unwrap_or(path);
        !below.split('/').any(|segment| segment == "node_modules")
    }

    /// Whether something below the folder `dir` may match.
    fn may_enter(&self, dir: &str) -> bool {
        self.glob.as_ref().is_some_and(|glob| {
            !matches!(glob.match_dir(dir.as_bytes()), DirMatch::Pruned | DirMatch::Match)
        })
    }
}

impl GlobSet {
    /// `include` and `exclude` are absolute patterns with `/` in `globstar`'s syntax;
    /// `exclude` is without the `!`, and one that starts with `**` matches anywhere.
    pub(crate) fn from_patterns(
        include: &[String],
        exclude: &[String],
        dot: bool,
        nocase: bool,
    ) -> Self {
        Self {
            include: include.iter().map(|glob| Pattern::new(glob, dot, nocase)).collect(),
            exclude: exclude.iter().map(|glob| Pattern::new(glob, dot, nocase)).collect(),
            dot,
            nocase,
        }
    }

    /// `path`, lower-case with `nocase`.
    fn fold<'p>(&self, path: &'p str) -> Cow<'p, str> {
        if self.nocase { Cow::Owned(path.to_lowercase()) } else { Cow::Borrowed(path) }
    }

    /// Whether the absolute path `path`, with `/`, counts: a positive pattern matches it,
    /// it is not in `node_modules` below that pattern's folder unless `exhaustive`, and no
    /// negative pattern matches it.
    pub(crate) fn is_match(&self, path: &str) -> bool {
        let path = self.fold(path);
        self.include.iter().any(|pattern| {
            pattern.matches(&path) && (self.dot || pattern.outside_node_modules(&path))
        }) && !self.exclude.iter().any(|pattern| pattern.matches(&path))
    }

    /// Whether the walk enters the absolute folder `dir`, with `/`: a positive pattern may
    /// match something below it. A folder that starts with `.` is entered only when a
    /// pattern spells its `.`, or with `exhaustive`.
    fn may_enter(&self, dir: &str) -> bool {
        let dir = self.fold(dir);
        self.include.iter().any(|pattern| pattern.may_enter(&dir))
    }
}

/// Add to `found` the files below `root` (to `depth` levels) that `set` accepts.
/// Without `dot`, folders named `node_modules` are skipped; the patterns decide on folders
/// that start with `.`. A linked folder is walked under the link's path, unless it leads
/// back into the branch.
fn walk(root: &str, depth: Option<u32>, dot: bool, set: &GlobSet, found: &mut Vec<String>) {
    let mut branch = vec![fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root))];
    walk_dir(root, 1, depth, dot, set, &mut branch, found);
}

/// `branch` holds the canonical path of each folder from the root to `dir`.
fn walk_dir(
    dir: &str,
    level: u32,
    depth: Option<u32>,
    dot: bool,
    set: &GlobSet,
    branch: &mut Vec<PathBuf>,
    found: &mut Vec<String>,
) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Ok(file_type) = entry.file_type() else { continue };
        let path =
            if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") };
        let link = file_type.is_symlink();
        let (is_dir, is_file) = if link {
            match fs::metadata(&path) {
                Ok(metadata) => (metadata.is_dir(), metadata.is_file()),
                // A broken link.
                Err(_) => continue,
            }
        } else {
            (file_type.is_dir(), file_type.is_file())
        };
        if is_file {
            if set.is_match(&path) {
                found.push(path);
            }
            continue;
        }
        if !is_dir
            || depth.is_some_and(|depth| level >= depth)
            || (!dot && name == "node_modules")
            || !set.may_enter(&path)
        {
            continue;
        }
        let canonical = if link {
            match fs::canonicalize(&path) {
                Ok(target) if !branch.contains(&target) => target,
                // A loop, or a target that cannot be named.
                _ => continue,
            }
        } else {
            branch.last().map_or_else(|| PathBuf::from(&path), |parent| parent.join(&name))
        };
        branch.push(canonical);
        walk_dir(&path, level + 1, depth, dot, set, branch, found);
        branch.pop();
    }
}

#[cfg(test)]
mod tests {
    use std::mem::ManuallyDrop;

    use napi::Either;
    use oxc::{
        codegen::Codegen,
        parser::{Parser, ParserReturn},
        span::SourceType,
    };
    use oxc_sourcemap::SourceMap;

    use super::*;
    use crate::{GlobMatcher, OxcTransformer, set_import_glob};

    /// A project in a fresh temp folder. Each file holds `export default "<name>";`.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str, files: &[&str]) -> Self {
            let root = env::temp_dir().join(format!("oxc-node-glob-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            // Real paths, as Node.js reports them (macOS keeps temp under a link).
            #[cfg(not(windows))]
            let root = fs::canonicalize(root).unwrap();
            let fixture = Self { root };
            for file in files {
                fixture.write(file, &format!("export default {};\n", json(file)));
            }
            fixture
        }

        fn write(&self, file: &str, contents: &str) {
            let path = self.root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }

        /// A file of the project, absolute and with `/`.
        fn path(&self, file: &str) -> String {
            normalize(&self.root.join(file).to_string_lossy().replace('\\', "/"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// An error message and the source text of its labels.
    type Message = (String, Vec<String>);

    /// The pass alone on `source` as the module `importer`: the printed code and the
    /// watch entries, or the error messages and their labels.
    fn run(
        importer: &str,
        source: &str,
    ) -> std::result::Result<(String, Vec<WatchGlob>), Vec<Message>> {
        let allocator = Allocator::default();
        let ParserReturn { mut program, diagnostics, .. } =
            Parser::new(&allocator, source, SourceType::mjs()).parse();
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        match expand_calls(&allocator, Path::new(importer), &mut program, source, true) {
            Ok(globs) => Ok((Codegen::new().build(&program).code, globs)),
            Err(errors) => Err(errors
                .into_iter()
                .map(|error| {
                    let labels = error
                        .labels
                        .iter()
                        .map(|label| {
                            let start = label.offset() as usize;
                            source[start..start + label.len() as usize].to_owned()
                        })
                        .collect();
                    (error.message.to_string(), labels)
                })
                .collect()),
        }
    }

    fn code(importer: &str, source: &str) -> String {
        match run(importer, source) {
            Ok((code, _)) => code,
            Err(errors) => panic!("{errors:?}"),
        }
    }

    /// The quoted strings in `code` that a `: ` follows: the keys of a map.
    fn keys(code: &str) -> Vec<String> {
        let parts: Vec<&str> = code.split('"').collect();
        (1..parts.len())
            .step_by(2)
            .filter(|&at| parts.get(at + 1).is_some_and(|next| next.starts_with(": ")))
            .map(|at| parts[at].to_owned())
            .collect()
    }

    /// The specifiers of the `import()` calls in `code`.
    fn imports(code: &str) -> Vec<String> {
        let parts: Vec<&str> = code.split('"').collect();
        (1..parts.len())
            .step_by(2)
            .filter(|&at| parts[at - 1].ends_with("import("))
            .map(|at| parts[at].to_owned())
            .collect()
    }

    fn errors(source: &str) -> Vec<Message> {
        let importer = if cfg!(windows) { "C:/app/main.mjs" } else { "/app/main.mjs" };
        match run(importer, source) {
            Ok((code, _)) => panic!("no error, but {code}"),
            Err(errors) => errors,
        }
    }

    fn error(message: &str, label: &str) -> Message {
        (message.to_owned(), vec![label.to_owned()])
    }

    /// The whole transform, with the pass on, as the `pirates` hook runs it.
    fn transform(path: &str, source: &str) -> std::result::Result<crate::Output, String> {
        set_import_glob(true);
        OxcTransformer::new(None, None)
            .transform(path.to_owned(), Either::A(source.to_owned()))
            // Dropping a napi `Error` calls into Node-API, which a test binary lacks.
            .map_err(|error| ManuallyDrop::new(error).reason.clone())
    }

    // Vite's `parse.spec.ts` positives that apply: one call, an array, options over
    // several lines, comments with `)`, `base`, and calls in objects and arrays.
    #[test]
    fn parses_what_vite_parses() {
        let fixture =
            Fixture::new("parse", &["modules/a.ts", "dir/b.js", "path/to/base/x/dir/c.md"]);
        let main = fixture.path("main.mjs");
        assert_eq!(
            code(&main, "import.meta.glob('./modules/*.ts');\n"),
            "Object.assign({ \"./modules/a.ts\": () => import(\"./modules/a.ts\") });\nexport {};\n"
        );
        assert_eq!(
            code(&main, "import.meta.glob(['./modules/*.ts', './dir/*.{js,ts}']);\n"),
            "Object.assign({\n\t\"./dir/b.js\": () => import(\"./dir/b.js\"),\n\t\"./modules/a.ts\": () => import(\"./modules/a.ts\")\n});\nexport {};\n"
        );
        let multiline = "import.meta.glob([\n  './modules/*.ts',\n  \"!./dir/*.{js,ts}\"\n], {\n  \
                         eager: true,\n  import: 'named'\n});\n";
        assert_eq!(
            code(&main, multiline),
            "import { named as __vite_glob_0_0 } from \"./modules/a.ts\";\nObject.assign({ \"./modules/a.ts\": __vite_glob_0_0 });\n"
        );
        let comments = "const modules = import.meta.glob(\n  './dir/**'\n  // for test: annotation contain \")\"\n  /*\n   * for test: annotation contain \")\"\n   * */\n);\n";
        assert_eq!(
            code(&main, comments),
            "const modules = Object.assign({ \"./dir/b.js\": () => import(\"./dir/b.js\") });\nexport {};\n"
        );
        assert_eq!(
            code(&main, "import.meta.glob('./**/dir/*.md', {\n  base: './path/to/base'\n});\n"),
            "Object.assign({ \"./x/dir/c.md\": () => import(\"./path/to/base/x/dir/c.md\") });\nexport {};\n"
        );
        let nested = "export const pageFiles = {\n  '.page': import.meta.glob('./modules/*.ts'),\n  \
                      list: [import.meta.glob('./dir/*.js')],\n};\n";
        assert_eq!(
            code(&main, nested),
            "export const pageFiles = {\n\t\".page\": Object.assign({ \"./modules/a.ts\": () => import(\"./modules/a.ts\") }),\n\tlist: [Object.assign({ \"./dir/b.js\": () => import(\"./dir/b.js\") })]\n};\n"
        );
        // A glob call in a string is text, and so is one in a comment.
        let text = "\"import.meta.glob()\";\n// import.meta.glob(1)\n";
        assert_eq!(code(&main, text), text);
    }

    // Vite's `parse.spec.ts` negatives, and oxc-node's own: every error of a call, each
    // with its label.
    #[test]
    fn rejects_what_vite_rejects() {
        let args =
            |n: usize| format!("Invalid glob import syntax: Expected 1-2 arguments, but got {n}");
        assert_eq!(errors("import.meta.glob();"), [error(&args(0), "import.meta.glob()")]);
        assert_eq!(
            errors("import.meta.glob('./a', {}, {});"),
            [error(&args(3), "import.meta.glob('./a', {}, {})")]
        );
        let literals = "Invalid glob import syntax: Could only use literals";
        assert_eq!(errors("import.meta.glob(hey);"), [error(literals, "hey")]);
        assert_eq!(errors("import.meta.glob([hey]);"), [error(literals, "hey")]);
        assert_eq!(errors("import.meta.glob(['./a', hey]);"), [error(literals, "hey")]);
        assert_eq!(errors("import.meta.glob(...hey);"), [error(literals, "...hey")]);
        assert_eq!(errors("import.meta.glob(['./a', ...hey]);"), [error(literals, "...hey")]);
        assert_eq!(
            errors("import.meta.glob(`./${hey}`);"),
            [error(
                "Invalid glob import syntax: Expected glob to be a string, but got dynamic template literal",
                "`./${hey}`"
            )]
        );
        let kind = |kind: &str| {
            format!("Invalid glob import syntax: Expected glob to be a string, but got \"{kind}\"")
        };
        assert_eq!(errors("import.meta.glob(1);"), [error(&kind("number"), "1")]);
        assert_eq!(
            errors("import.meta.glob([true, 1n, null, /x/]);"),
            [
                error(&kind("boolean"), "true"),
                error(&kind("bigint"), "1n"),
                error(&kind("object"), "null"),
                error(&kind("object"), "/x/"),
            ]
        );
        let object =
            "Invalid glob import syntax: Expected the second argument to be an object literal";
        assert_eq!(errors("import.meta.glob('./a', hey);"), [error(object, "hey")]);
        assert_eq!(errors("import.meta.glob('./a', []);"), [error(object, "[]")]);
        assert_eq!(
            errors("import.meta.glob('./a', { hey: 1 });"),
            [error("Unknown glob option \"hey\"", "hey")]
        );
        let not_static = "Unable to parse the glob options as the value is not static";
        assert_eq!(
            errors("import.meta.glob('./a', { import: hey });"),
            [error(not_static, "import: hey")]
        );
        assert_eq!(
            errors(
                "import.meta.glob('./a', { ...o, [k]: 1, eager, base() {}, get x() { return 1 } });"
            ),
            [
                error(not_static, "...o"),
                error(not_static, "[k]: 1"),
                error(not_static, "eager"),
                error(not_static, "base() {}"),
                error(not_static, "get x() { return 1 }"),
            ]
        );
        assert_eq!(
            errors(
                "import.meta.glob('./a', { eager: 123, import: true, base: 1, caseSensitive: 'no' });"
            ),
            [
                error(
                    "Expected glob option \"eager\" to be of type boolean, but got number",
                    "123"
                ),
                error(
                    "Expected glob option \"import\" to be of type string, but got boolean",
                    "true"
                ),
                error("Expected glob option \"base\" to be of type string, but got number", "1"),
                error(
                    "Expected glob option \"caseSensitive\" to be of type boolean, but got string",
                    "'no'"
                ),
            ]
        );
        let unsupported = |key: &str| {
            format!(
                "Glob option \"{key}\" is not supported: Node.js loads each matched file as a \
                 module, without import queries"
            )
        };
        assert_eq!(
            errors("import.meta.glob('./*.js', { as: 'raw', query: { foo: hey } });"),
            [
                error(&unsupported("as"), "as: 'raw'"),
                error(&unsupported("query"), "query: { foo: hey }")
            ]
        );
        assert_eq!(
            errors("import.meta.glob('./*.js', { base: '!/foo' });"),
            [error("Option \"base\" cannot start with \"!\"", "'!/foo'")]
        );
        let root = |glob: &str| {
            format!(
                "Invalid glob: \"{glob}\". oxc-node has no project root, so the glob must start \
                 with './' or '../'"
            )
        };
        let alias = |glob: &str| {
            format!(
                "Invalid glob: \"{glob}\". oxc-node resolves no aliases in globs, so the glob \
                 must start with './' or '../'"
            )
        };
        assert_eq!(
            errors("import.meta.glob('./*.js', { base: '/src' });"),
            [error(&root("/src"), "'/src'")]
        );
        assert_eq!(
            errors("import.meta.glob('./*.js', { base: 'foo' });"),
            [error(&alias("foo"), "'foo'")]
        );
        assert_eq!(
            errors(
                "import.meta.glob(['/src/*.ts', '**/*.ts', '!/src/x.ts', '@/a/*.ts', '#a/*', 'pkg/*.ts', `!x`, '', '!**/ok.ts', '../ok/*.ts']);"
            ),
            [
                error(&root("/src/*.ts"), "'/src/*.ts'"),
                error(&root("**/*.ts"), "'**/*.ts'"),
                error(&root("!/src/x.ts"), "'!/src/x.ts'"),
                error(&alias("@/a/*.ts"), "'@/a/*.ts'"),
                error(&alias("#a/*"), "'#a/*'"),
                error(&alias("pkg/*.ts"), "'pkg/*.ts'"),
                error(&alias("!x"), "`!x`"),
                error(&alias(""), "''"),
            ]
        );
        // Every call is checked.
        assert_eq!(
            errors("import.meta.glob(a);\nimport.meta.glob('./ok/*.ts');\nimport.meta.glob(b);"),
            [error(literals, "a"), error(literals, "b")]
        );
    }

    #[test]
    fn only_a_direct_call_expands() {
        let fixture = Fixture::new("direct", &["a.ts"]);
        let main = fixture.path("main.mjs");
        for source in [
            "const glob = import.meta.glob;\n",
            "(import.meta.glob)('./*.ts');\n",
            "import.meta.glob?.('./*.ts');\n",
            "import.meta?.glob('./*.ts');\n",
            "import.meta.globs('./*.ts');\n",
            "meta.glob('./*.ts');\n",
        ] {
            let allocator = Allocator::default();
            let ParserReturn { program, .. } =
                Parser::new(&allocator, source, SourceType::mjs()).parse();
            let printed = Codegen::new().build(&program).code;
            assert_eq!(code(&main, source), printed, "{source}");
        }
    }

    // Keys and import paths relative to the importer, or to `base`; negative patterns.
    #[test]
    fn keys_and_import_paths() {
        let fixture = Fixture::new(
            "keys",
            &["src/routes/a.ts", "src/routes/b.ts", "src/routes/sub/c.ts", "shared/x.ts"],
        );
        let main = fixture.path("src/main.mjs");
        let map = |source: &str| {
            let code = code(&main, source);
            keys(&code).into_iter().zip(imports(&code)).collect::<Vec<_>>()
        };
        let pair = |key: &str, path: &str| (key.to_owned(), path.to_owned());
        assert_eq!(
            map("import.meta.glob(['./routes/**/*.ts', '!./routes/b.ts', '../shared/*.ts']);"),
            [
                pair("../shared/x.ts", "../shared/x.ts"),
                pair("./routes/a.ts", "./routes/a.ts"),
                pair("./routes/sub/c.ts", "./routes/sub/c.ts"),
            ]
        );
        assert_eq!(
            map("import.meta.glob(['./**/*.ts', '!**/sub/*.ts'], { base: './routes' });"),
            [pair("./a.ts", "./routes/a.ts"), pair("./b.ts", "./routes/b.ts")]
        );
        assert_eq!(
            map("import.meta.glob('../*.ts', { base: './routes/sub' });"),
            [pair("../a.ts", "./routes/a.ts"), pair("../b.ts", "./routes/b.ts")]
        );
        assert_eq!(
            map("import.meta.glob('./x.ts', { base: '../shared/' });"),
            [pair("./x.ts", "../shared/x.ts")]
        );
        // Only negative patterns: nothing matches.
        assert_eq!(
            code(&main, "import.meta.glob('!./routes/*.ts');"),
            "Object.assign({});\nexport {};\n"
        );
        // The order of `Array.prototype.sort()`: `-` and `.` come before `/`.
        let order = Fixture::new("order", &["routes/a.ts", "routes/a/z.ts", "routes/a-b.ts"]);
        assert_eq!(
            code(&order.path("main.mjs"), "Object.keys(import.meta.glob('./routes/**/*.ts'));"),
            "Object.keys({\n\t\"./routes/a-b.ts\": 0,\n\t\"./routes/a.ts\": 0,\n\t\"./routes/a/z.ts\": 0\n});\nexport {};\n"
        );
    }

    #[test]
    fn the_importer_is_left_out_of_the_map_but_listed_for_the_watcher() {
        let fixture = Fixture::new("self", &["b.ts"]);
        fixture.write("main.ts", "");
        let main = fixture.path("main.ts");
        let (code, globs) = run(&main, "import.meta.glob('./*.ts');\n").unwrap();
        assert_eq!(code, "Object.assign({ \"./b.ts\": () => import(\"./b.ts\") });\nexport {};\n");
        assert_eq!(
            globs,
            [WatchGlob {
                roots: vec![WatchGlobRoot { base: fixture.path(""), depth: Some(1) }],
                include: vec![format!("{}/*.ts", escape(&fixture.path("")))],
                exclude: None,
                dot: None,
                nocase: None,
                files: Some(vec![fixture.path("b.ts"), main.clone()]),
            }]
        );
        // One entry per call with a positive pattern, with its options.
        let source = "import.meta.glob(['./a/**/*.ts', './{b,c}/*.ts', '!**/x.ts'], { exhaustive: true, caseSensitive: false });\n\
                      import.meta.glob('!./*.ts');\n\
                      Object.keys(import.meta.glob('./*/*.ts'));\n";
        let (_, globs) = run(&main, source).unwrap();
        let base = fixture.path("");
        assert_eq!(
            globs,
            [
                WatchGlob {
                    roots: vec![
                        WatchGlobRoot { base: fixture.path("a"), depth: None },
                        WatchGlobRoot { base: base.clone(), depth: None },
                    ],
                    include: vec![
                        format!("{}/**/*.ts", escape(&fixture.path("a"))),
                        format!("{}/{{b,c}}/*.ts", escape(&base)),
                    ],
                    exclude: Some(vec!["**/x.ts".to_owned()]),
                    dot: Some(true),
                    nocase: Some(true),
                    files: Some(vec![]),
                },
                WatchGlob {
                    roots: vec![WatchGlobRoot { base: base.clone(), depth: Some(2) }],
                    include: vec![format!("{}/*/*.ts", escape(&base))],
                    exclude: None,
                    dot: None,
                    nocase: None,
                    files: Some(vec![]),
                },
            ]
        );
        // No entry unless asked.
        let allocator = Allocator::default();
        let source = "import.meta.glob('./*.ts');\n";
        let mut program = Parser::new(&allocator, source, SourceType::mjs()).parse().program;
        assert!(
            expand_calls(&allocator, Path::new(&main), &mut program, source, false)
                .unwrap()
                .is_empty()
        );
    }

    // Without `exhaustive`, as picomatch without `dot` and with `**/node_modules/**`
    // ignored: hidden below the folder before the first glob character.
    #[test]
    fn dot_names_node_modules_and_case() {
        let fixture = Fixture::new(
            "dot",
            &[
                "r/a.ts",
                "r/.hidden.ts",
                "r/.dir/x.ts",
                "r/node_modules/y.ts",
                "r/sub/.z.ts",
                "r/B.TS",
                "node_modules/pkg/p.ts",
            ],
        );
        let main = fixture.path("main.mjs");
        let keys =
            |source: &str| keys(&code(&main, &format!("Object.keys(import.meta.glob({source}));")));
        assert_eq!(keys("'./r/**/*.ts'"), ["./r/a.ts"]);
        assert_eq!(keys("'./r/**/.*.ts'"), ["./r/.hidden.ts", "./r/sub/.z.ts"]);
        assert_eq!(keys("'./r/.dir/*.ts'"), ["./r/.dir/x.ts"]);
        assert_eq!(keys("'./r/node_modules/*.ts'"), ["./r/node_modules/y.ts"]);
        assert_eq!(keys("'./node_modules/pkg/*.ts'"), ["./node_modules/pkg/p.ts"]);
        assert_eq!(keys("'./**/p.ts'"), Vec::<String>::new());
        assert_eq!(
            keys("'./r/**/*.ts', { exhaustive: true }"),
            [
                "./r/.dir/x.ts",
                "./r/.hidden.ts",
                "./r/a.ts",
                "./r/node_modules/y.ts",
                "./r/sub/.z.ts"
            ]
        );
        assert_eq!(keys("'./r/*.ts', { caseSensitive: false }"), ["./r/B.TS", "./r/a.ts"]);
        assert_eq!(keys("'./r/*.TS', { caseSensitive: false }"), ["./r/B.TS", "./r/a.ts"]);
        assert_eq!(keys("'./r/*.ts', { caseSensitive: true }"), ["./r/a.ts"]);
        // `{` and `**` walk any depth; otherwise as deep as the pattern reaches.
        assert_eq!(keys("'./*/{a,b}.ts'"), ["./r/a.ts"]);
        assert_eq!(
            keys("'./*/*/*.ts', { exhaustive: true }"),
            ["./node_modules/pkg/p.ts", "./r/.dir/x.ts", "./r/node_modules/y.ts", "./r/sub/.z.ts"]
        );
    }

    // The `picomatch` forms that Vite reads and `globstar` lacks, in `globstar`'s syntax.
    #[test]
    fn translates_picomatch_forms() {
        let one = |pattern: &str| {
            let mut translated = translate(pattern);
            assert_eq!(translated.len(), 1, "{pattern}: {translated:?}");
            translated.remove(0)
        };
        assert_eq!(one("./routes/**/index.(ts|tsx)"), "./routes/**/index.{ts,tsx}");
        assert_eq!(one("./(a|b(c|d))/*.ts"), "./{a,b{c,d}}/*.ts");
        assert_eq!(one("./(a,b|c)/*.ts"), "./{a\\,b,c}/*.ts");
        assert_eq!(one("./(x)*.ts"), "./x*.ts");
        assert_eq!(one("./a\\(1|2\\).js"), "./a\\(1|2\\).js");
        assert_eq!(one("./a(1|2.js"), "./a(1|2.js");
        assert_eq!(one("./a{1..3}.js"), "./a[1-3].js");
        assert_eq!(one("./a{3..1}.js"), "./a[1-3].js");
        assert_eq!(one("./a{c..a}.js"), "./a[a-c].js");
        assert_eq!(one("./a{1..3..2}.js"), "./a[1-3].js");
        assert_eq!(one("./a{1..12}.js"), "./a{1..12}.js");
        assert_eq!(one("./a{a..C}.js"), "./a{a..C}.js");
        assert_eq!(one("./a{1..3}{x,y}.js"), "./a[1-3]{x,y}.js");
        assert_eq!(one("./a[[:digit:]].js"), "./a[0-9].js");
        assert_eq!(one("./a[[:alnum:]_].js"), "./a[a-zA-Z0-9_].js");
        assert_eq!(one("./a[![:upper:]].js"), "./a[!A-Z].js");
        assert_eq!(one("./a[[:nope:]].js"), "./a[[:nope:]].js");
        // A pattern whose only glob syntax is a group: also its literal text.
        assert_eq!(translate("./(auth)/x.ts"), ["./auth/x.ts", "./(auth)/x.ts"]);
        assert_eq!(translate("./(a|b)/x.ts"), ["./{a,b}/x.ts", "./(a|b)/x.ts"]);
        assert_eq!(translate("./(auth)/*.ts"), ["./auth/*.ts"]);
    }

    #[test]
    fn picomatch_forms_list_what_vite_lists() {
        let fixture = Fixture::new(
            "picomatch-forms",
            &[
                "r/x.ts",
                "r/x.tsx",
                "r/x.mdx",
                "r/a1.js",
                "r/a2.js",
                "r/a3.js",
                "r/a12.js",
                "r/ab.js",
                "r/aZ.js",
                "r/(auth)/in.ts",
                "r/auth/out.ts",
                "r/(auth)/x.ts",
                "r/auth/x.ts",
            ],
        );
        let main = fixture.path("main.mjs");
        let keys =
            |source: &str| keys(&code(&main, &format!("Object.keys(import.meta.glob({source}));")));
        assert_eq!(keys("'./r/x.(ts|tsx)'"), ["./r/x.ts", "./r/x.tsx"]);
        assert_eq!(keys("['./r/*.(ts|tsx|mdx)', '!./r/*.(mdx)']"), ["./r/x.ts", "./r/x.tsx"]);
        assert_eq!(keys("'./r/a{1..2}.js'"), ["./r/a1.js", "./r/a2.js"]);
        assert_eq!(keys("'./r/a{1..12}.js'"), Vec::<String>::new());
        assert_eq!(keys("'./r/a[[:digit:]].js'"), ["./r/a1.js", "./r/a2.js", "./r/a3.js"]);
        assert_eq!(keys("'./r/a[[:upper:]].js'"), ["./r/aZ.js"]);
        assert_eq!(keys("'./r/(auth)/*.ts'"), ["./r/auth/out.ts", "./r/auth/x.ts"]);
        assert_eq!(keys("'./r/(auth)/x.ts'"), ["./r/(auth)/x.ts", "./r/auth/x.ts"]);
    }

    // `picomatch` takes a name that starts with `.` wherever a segment of the pattern spells
    // the `.`, also after a wildcard; `globstar` reads `dot` the same way.
    #[test]
    fn a_dot_folder_that_the_pattern_names_after_a_wildcard() {
        let fixture = Fixture::new(
            "dot-after-wildcard",
            &["r/a/.config/x.ts", "r/a/b/.config/y.ts", "r/a/.other/z.ts", "r/a/w.ts"],
        );
        let main = fixture.path("main.mjs");
        let keys =
            |source: &str| keys(&code(&main, &format!("Object.keys(import.meta.glob({source}));")));
        assert_eq!(keys("'./r/*/.config/*.ts'"), ["./r/a/.config/x.ts"]);
        assert_eq!(keys("'./r/**/.config/*.ts'"), ["./r/a/.config/x.ts", "./r/a/b/.config/y.ts"]);
        assert_eq!(keys("'./r/**/*.ts'"), ["./r/a/w.ts"]);
        let matcher = GlobMatcher::new(
            vec![format!("{}/*/.config/*.ts", fixture.path("r"))],
            None,
            None,
            None,
        );
        assert!(matcher.matches(fixture.path("r/b/.config/new.ts")));
        assert!(!matcher.matches(fixture.path("r/b/.other/new.ts")));
    }

    // A specifier is a URL: `%`, `#` and `?` in a file name are encoded there, not in the key.
    #[test]
    fn url_characters_in_file_names() {
        let fixture =
            Fixture::new("url-chars", &["r/name#part.ts", "r/name%20part.ts", "r/name part.ts"]);
        let main = fixture.path("main.mjs");
        let lazy = code(&main, "const m = import.meta.glob('./r/*.ts');");
        for expected in [
            r#""./r/name part.ts": () => import("./r/name part.ts")"#,
            r#""./r/name#part.ts": () => import("./r/name%23part.ts")"#,
            r#""./r/name%20part.ts": () => import("./r/name%2520part.ts")"#,
        ] {
            assert!(lazy.contains(expected), "{expected} in {lazy}");
        }
        let eager = code(&main, "const m = import.meta.glob('./r/*.ts', { eager: true });");
        for expected in [
            r#"__vite_glob_0_1 from "./r/name%23part.ts";"#,
            r#"__vite_glob_0_2 from "./r/name%2520part.ts";"#,
            r#""./r/name#part.ts": __vite_glob_0_1"#,
        ] {
            assert!(eager.contains(expected), "{expected} in {eager}");
        }
        // Characters a file name cannot hold on every platform.
        assert_eq!(url_specifier("./a?b\\c\td\ne\rf.ts"), "./a%3Fb%5Cc%09d%0Ae%0Df.ts");
        assert_eq!(url_specifier("./é f.ts"), "./é f.ts");
    }

    // A name spelled with a `\u` escape is not in the source text as the name.
    #[test]
    fn generated_names_avoid_escaped_identifiers() {
        let fixture = Fixture::new("escaped-names", &["r/a.ts"]);
        let main = fixture.path("main.mjs");
        let glob = "const m = import.meta.glob('./r/*.ts', { eager: true });";
        // A declaration that the import would redeclare.
        let declared = code(&main, &format!("const \\u005f_vite_glob_0_0 = 'mine';\n{glob}"));
        assert!(declared.contains("import * as __vite_glob__0_0 from"), "{declared}");
        // A global that the import would shadow.
        let referenced = code(&main, &format!("console.log(\\u005f_vite_glob_0_0);\n{glob}"));
        assert!(referenced.contains("import * as __vite_glob__0_0 from"), "{referenced}");
        // Without an escape, the source text is enough.
        let plain = code(&main, glob);
        assert!(plain.contains("import * as __vite_glob_0_0 from"), "{plain}");
    }

    // The rules the watcher's `GlobMatcher` applies are the transform's.
    #[test]
    fn glob_matcher_matches_as_the_transform_lists() {
        let matcher = |include: &[&str], exclude: &[&str], dot, nocase| {
            GlobMatcher::new(
                include.iter().map(|g| (*g).to_owned()).collect(),
                Some(exclude.iter().map(|g| (*g).to_owned()).collect()),
                Some(dot),
                Some(nocase),
            )
        };
        let routes = matcher(&["/p/routes/**/*.ts"], &["**/*.test.ts"], false, false);
        assert!(routes.matches("/p/routes/a.ts".into()));
        assert!(routes.matches("/p/routes/deep/a.ts".into()));
        assert!(!routes.matches("/p/routes/a.test.ts".into()));
        assert!(!routes.matches("/p/routes/.a.ts".into()));
        assert!(!routes.matches("/p/routes/.git/a.ts".into()));
        assert!(!routes.matches("/p/routes/node_modules/a.ts".into()));
        assert!(!routes.matches("/p/other/a.ts".into()));
        assert!(!routes.matches("/p/routes/A.TS".into()));
        let dot = matcher(&["/p/routes/**/*.ts"], &[], true, true);
        assert!(dot.matches("/p/routes/node_modules/.x/A.TS".into()));
        // A folder named like a glob is literal once escaped.
        let literal = matcher(&["/p/a\\[1\\]/*.ts"], &[], false, false);
        assert!(literal.matches("/p/a[1]/x.ts".into()));
        assert!(!literal.matches("/p/a1/x.ts".into()));
        // `globstar` rejects an unclosed brace: it matches nothing, so it excludes nothing.
        assert!(!matcher(&["/p/{a,b/*.ts"], &[], false, false).matches("/p/{a,b/x.ts".into()));
        assert!(matcher(&["/p/*.ts"], &["/p/*.{ts"], false, false).matches("/p/x.ts".into()));
        let windows = matcher(&["C:/p/*.ts"], &["**/b.ts"], false, false);
        assert!(windows.matches("C:/p/a.ts".into()));
        assert!(!windows.matches("C:/p/b.ts".into()));
    }

    #[cfg(unix)]
    #[test]
    fn linked_folders_and_loops() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new("links", &["routes/a.ts", "shared/x.ts", "shared/deep/y.ts"]);
        symlink(fixture.root.join("shared"), fixture.root.join("routes/linked")).unwrap();
        // Back to its own folder, and to the folder above.
        symlink(".", fixture.root.join("routes/self")).unwrap();
        symlink("..", fixture.root.join("shared/deep/up")).unwrap();
        symlink("missing", fixture.root.join("routes/broken.ts")).unwrap();
        symlink("a.ts", fixture.root.join("routes/alias.ts")).unwrap();
        let main = fixture.path("main.mjs");
        assert_eq!(
            code(&main, "Object.keys(import.meta.glob('./routes/**/*.ts'));"),
            "Object.keys({\n\t\"./routes/a.ts\": 0,\n\t\"./routes/alias.ts\": 0,\n\t\"./routes/linked/deep/y.ts\": 0,\n\t\"./routes/linked/x.ts\": 0\n});\nexport {};\n"
        );
    }

    #[test]
    fn a_folder_with_glob_characters_is_literal() {
        let fixture = Fixture::new(
            "chars",
            &["app [1]{x}/routes/a.ts", "app [1]{x}/routes/b.ts", "app 1x/routes/c.ts"],
        );
        let main = fixture.path("app [1]{x}/main.mjs");
        assert_eq!(
            code(&main, "Object.keys(import.meta.glob(['./routes/*.ts', '!./routes/b.ts']));"),
            "Object.keys({ \"./routes/a.ts\": 0 });\nexport {};\n"
        );
        // An escaped character in the folder part of the pattern is literal too.
        let fixture = Fixture::new("escaped", &["r[1]/a.ts", "r1/b.ts"]);
        assert_eq!(
            code(
                &fixture.path("main.mjs"),
                "Object.keys(import.meta.glob('./r\\\\[1\\\\]/*.ts'));"
            ),
            "Object.keys({ \"./r[1]/a.ts\": 0 });\nexport {};\n"
        );
    }

    #[test]
    fn generated_code_of_each_form() {
        let fixture = Fixture::new("forms", &["m/a.ts", "m/b-c.ts"]);
        let main = fixture.path("main.mjs");
        let lazy = "() => import(\"./m/a.ts\")";
        let lazy_bc = "() => import(\"./m/b-c.ts\")";
        assert_eq!(
            code(&main, "const m = import.meta.glob('./m/*.ts', { import: 'default' });"),
            "const m = Object.assign({\n\t\"./m/a.ts\": () => import(\"./m/a.ts\").then((m) => m[\"default\"]),\n\t\"./m/b-c.ts\": () => import(\"./m/b-c.ts\").then((m) => m[\"default\"])\n});\nexport {};\n"
        );
        assert_eq!(
            code(&main, "const m = import.meta.glob('./m/*.ts', { import: '*' });"),
            format!(
                "const m = Object.assign({{\n\t\"./m/a.ts\": {lazy},\n\t\"./m/b-c.ts\": {lazy_bc}\n}});\nexport {{}};\n"
            )
        );
        assert_eq!(
            code(
                &main,
                "#!/usr/bin/env node\n'use strict';\nimport './x.ts';\nconst m = import.meta.glob('./m/*.ts', { eager: true });\nconst n = import.meta.glob('./m/a.ts', { eager: true, import: 'a-b' });"
            ),
            "#!/usr/bin/env node\n\"use strict\";\nimport * as __vite_glob_0_0 from \"./m/a.ts\";\nimport * as __vite_glob_0_1 from \"./m/b-c.ts\";\nimport { \"a-b\" as __vite_glob_1_0 } from \"./m/a.ts\";\nimport \"./x.ts\";\nconst m = Object.assign({\n\t\"./m/a.ts\": __vite_glob_0_0,\n\t\"./m/b-c.ts\": __vite_glob_0_1\n});\nconst n = Object.assign({ \"./m/a.ts\": __vite_glob_1_0 });\n"
        );
        assert_eq!(
            code(&main, "const k = Object.keys(import.meta.glob('./m/*.ts', { eager: true }));"),
            "const k = Object.keys({\n\t\"./m/a.ts\": 0,\n\t\"./m/b-c.ts\": 0\n});\nexport {};\n"
        );
        assert_eq!(
            code(&main, "const v = Object.values(import.meta.glob('./m/*.ts'));"),
            format!("const v = Object.values([{lazy}, {lazy_bc}]);\nexport {{}};\n")
        );
        assert_eq!(
            code(
                &main,
                "const v = Object.values(import.meta.glob('./m/a.ts', { eager: true, import: 'default' }), 2);"
            ),
            "import { default as __vite_glob_0_0 } from \"./m/a.ts\";\nconst v = Object.values([__vite_glob_0_0], 2);\n"
        );
        // Names the source uses already get one more `_`.
        assert_eq!(
            code(
                &main,
                "const __vite_glob_0_0 = 1;\nimport.meta.glob('./m/a.ts', { eager: true });"
            ),
            "import * as __vite_glob__0_0 from \"./m/a.ts\";\nconst __vite_glob_0_0 = 1;\nObject.assign({ \"./m/a.ts\": __vite_glob__0_0 });\n"
        );
    }

    // `export {}` keeps a file an ES module when the glob call was its only module syntax.
    #[test]
    fn the_module_marker() {
        let fixture = Fixture::new("marker", &["a.ts"]);
        let main = fixture.path("main.mjs");
        let glob = "Object.assign({ \"./a.ts\": () => import(\"./a.ts\") })";
        assert_eq!(code(&main, "import.meta.glob('./a.ts');"), format!("{glob};\nexport {{}};\n"));
        assert_eq!(
            code(&main, "import.meta.glob('./a.ts');\nimport.meta.url;"),
            format!("{glob};\nimport.meta.url;\n")
        );
        assert_eq!(
            code(&main, "import.meta.glob('./a.ts');\nexport const x = 1;"),
            format!("{glob};\nexport const x = 1;\n")
        );
        assert_eq!(code(&main, "import.meta.url; // glob\n"), "import.meta.url;\n");
    }

    // The whole transform: TypeScript first, then the pass; tokens after a glob call keep
    // their place in the source map, and errors come with a code frame.
    #[test]
    fn through_the_transform() {
        let fixture = Fixture::new("transform", &["routes/health.ts"]);
        let main = fixture.path("server.ts");
        let source = "interface Hook {}\nconst routes = import.meta.glob<Hook>('./routes/*.ts'); export const after: number = 1;\n";
        let output = transform(&main, source).unwrap();
        assert_eq!(
            output.code,
            "\"use strict\";\nconst routes = Object.assign({ \"./routes/health.ts\": () => import(\"./routes/health.ts\") });\nexport const after = 1;\n"
        );
        let map = output.map.as_ref().unwrap().to_json_string();
        let map = SourceMap::from_json_string(&map).unwrap();
        let line = output.code.lines().position(|line| line.contains("after")).unwrap() as u32;
        let column = output.code.lines().nth(line as usize).unwrap().find("after").unwrap() as u32;
        let token = map
            .get_tokens()
            .find(|token| token.get_dst_line() == line && token.get_dst_col() == column)
            .expect("a mapping for `after`");
        let source_column = source.lines().nth(1).unwrap().find("after").unwrap() as u32;
        assert_eq!((token.get_src_line(), token.get_src_col()), (1, source_column));

        let Err(error) =
            transform(&main, "const a = 1;\nconst routes = import.meta.glob(pattern);\n")
        else {
            panic!("no error");
        };
        assert!(error.starts_with(&format!("Failed to transform {main}:\n")), "{error}");
        assert!(error.contains("x Invalid glob import syntax: Could only use literals"), "{error}");
        assert!(error.contains("server.ts:2:33]"), "{error}");
        assert!(error.contains("2 | const routes = import.meta.glob(pattern);"), "{error}");

        // Off by default, and per thread.
        std::thread::spawn(move || {
            let output = OxcTransformer::new(None, None)
                .transform(main, Either::A("import.meta.glob('./routes/*.ts');\n".to_owned()))
                .map_err(|error| ManuallyDrop::new(error).reason.clone())
                .unwrap();
            assert_eq!(output.code, "\"use strict\";\nimport.meta.glob(\"./routes/*.ts\");\n");
        })
        .join()
        .unwrap();
    }

    #[test]
    fn paths() {
        assert_eq!(normalize("/a/./b/../c//d/"), "/a/c/d");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(normalize("C:/a/../.."), "C:/");
        assert_eq!(normalize("//server/share/a/../b"), "//server/share/b");
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/a/b", "../c"), "/a/c");
        assert_eq!(parent("/a/b.ts"), "/a");
        assert_eq!(parent("/b.ts"), "/");
        assert_eq!(parent("C:/b.ts"), "C:/");
        assert_eq!(relative("/a/b", "/a/c/d.ts"), "../c/d.ts");
        assert_eq!(relative_import("/a", "/a/d.ts"), "./d.ts");
        assert_eq!(relative_import("/", "/d.ts"), "./d.ts");
        assert!(is_url("data:text/javascript,1") && is_url("custom+x:a") && !is_url("C:/a.ts"));
        assert_eq!(importer_path(Path::new("data:text/javascript,1")), None);
        let r = resolve("/app/x [1]", "./a/\\{b\\}/*.ts");
        assert_eq!(
            (r.dir.as_str(), r.pattern.as_str(), r.depth),
            ("/app/x [1]/a/{b}", "/app/x \\[1\\]/a/\\{b\\}/*.ts", Some(1))
        );
        let r = resolve("/", "./*.ts");
        assert_eq!((r.dir.as_str(), r.pattern.as_str()), ("/", "/*.ts"));
        assert_eq!(resolve("/app", "../**/x.ts").depth, None);
        assert_eq!(resolve("/app", "./a.ts").dir, "/app");
    }
}
