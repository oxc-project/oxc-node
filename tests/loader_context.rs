#![cfg(not(feature = "napi"))]

use std::{
    fs,
    mem::ManuallyDrop,
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    process::Command,
    sync::mpsc,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use napi::Either;
use oxc_node::{
    CapturedLoaderContext, OxcTransformer, get_tsconfig_path, set_transform_deps, set_tsconfig_path,
};

const SOURCE: &str = r#"
let setterCalls: number = 0;
class Base {
    set value(value: number) { setterCalls += value; }
}
class Derived extends Base { value = 1; }
new Derived();
console.log(setterCalls);
"#;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir()
            .join(format!("oxc-node-loader-context-{}-{unique}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        for (name, define) in [("assign", false), ("define", true)] {
            fs::write(
                root.join(format!("{name}.json")),
                format!(r#"{{"compilerOptions":{{"target":"esnext","useDefineForClassFields":{define}}}}}"#),
            )
            .unwrap();
        }
        fs::write(root.join("input.ts"), SOURCE).unwrap();
        Self(root)
    }

    fn config(&self, name: &str) -> String {
        self.0.join(format!("{name}.json")).to_string_lossy().into_owned()
    }

    fn transformer(&self) -> OxcTransformer {
        OxcTransformer::new(Some(self.0.to_string_lossy().into_owned()), None)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn unwrap_oxc<T>(result: napi::Result<T>) -> T {
    match result {
        Ok(value) => value,
        // Test executables do not provide the Node-API functions used by Error's drop.
        Err(error) => panic!("{}", ManuallyDrop::new(error).reason),
    }
}

fn transform(transformer: &OxcTransformer) -> String {
    unwrap_oxc(transformer.transform("input.ts".into(), Either::A(SOURCE.into()))).source()
}

fn setter_calls(source: &str) -> u32 {
    let output = Command::new("node")
        .args(["--input-type=commonjs", "--eval", source])
        .output()
        .expect("Node.js must be available for the emitted-code regression test");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().parse().unwrap()
}

fn error_reason<T>(result: napi::Result<T>) -> String {
    match result {
        Ok(value) => {
            drop(value);
            panic!("expected a loader error");
        }
        Err(error) => ManuallyDrop::new(error).reason.clone(),
    }
}

fn capture(fixture: &Fixture, config: &str) -> (OxcTransformer, CapturedLoaderContext) {
    thread::scope(|scope| {
        scope
            .spawn(|| {
                unwrap_oxc(set_tsconfig_path(Some(fixture.config(config))));
                unwrap_oxc(set_transform_deps(Some("off".into())));
                let transformer = fixture.transformer();
                // Capture before this caller's first transform, then let it exit.
                let context = transformer.capture_context();
                let other = if config == "assign" { "define" } else { "assign" };
                assert!(
                    error_reason(set_tsconfig_path(Some(fixture.config(other))))
                        .contains("before the first transform or resolve")
                );
                assert!(
                    error_reason(set_transform_deps(Some("all".into())))
                        .contains("before the first transform or resolve")
                );
                (transformer, context)
            })
            .join()
            .unwrap()
    })
}

#[test]
fn external_tasks_keep_each_callers_configuration() {
    let fixture = Fixture::new();
    let (assign, assign_context) = capture(&fixture, "assign");
    let (define, define_context) = capture(&fixture, "define");
    thread::scope(|scope| {
        let fixture = &fixture;
        let (send, receive) =
            mpsc::channel::<(CapturedLoaderContext, OxcTransformer, mpsc::Sender<String>)>();
        let task_thread = scope.spawn(move || {
            // A real pool thread can already have initialized a different loader.
            let own_config = fixture.config("define");
            unwrap_oxc(set_tsconfig_path(Some(own_config.clone())));
            let own_transformer = fixture.transformer();
            assert_eq!(setter_calls(&transform(&own_transformer)), 0);
            for (context, transformer, reply) in receive {
                let output = context.with(|| transform(&transformer));
                reply.send(output).unwrap();
                assert_eq!(get_tsconfig_path().as_deref(), Some(own_config.as_str()));
                assert_eq!(setter_calls(&transform(&own_transformer)), 0);
            }
        });
        for (context, transformer, expected) in [
            (assign_context.clone(), assign, 1),
            (define_context, define, 0),
            (assign_context, fixture.transformer(), 1),
        ] {
            let (reply, result) = mpsc::channel();
            send.send((context, transformer, reply)).unwrap();
            assert_eq!(setter_calls(&result.recv().unwrap()), expected);
        }
        drop(send);
        task_thread.join().unwrap();
    });
}

#[test]
fn nested_contexts_restore_after_errors_and_panics() {
    let fixture = Fixture::new();
    let (assign, assign_context) = capture(&fixture, "assign");
    let (define, define_context) = capture(&fixture, "define");
    assert_eq!(get_tsconfig_path(), None);
    assign_context.with(|| {
        assert_eq!(setter_calls(&transform(&assign)), 1);
        let invalid = define_context.with(|| {
            assert_eq!(setter_calls(&transform(&define)), 0);
            error_reason(define.transform("input.ts".into(), Either::A("let =".into())))
        });
        assert!(!invalid.is_empty());
        assert_eq!(get_tsconfig_path(), Some(fixture.config("assign")));
        let panic = catch_unwind(AssertUnwindSafe(|| {
            define_context.with(|| panic!("task panic"));
        }));
        assert!(panic.is_err());
        assert_eq!(get_tsconfig_path(), Some(fixture.config("assign")));
        assert_eq!(setter_calls(&transform(&assign)), 1);
    });
    assert_eq!(get_tsconfig_path(), None);
}
