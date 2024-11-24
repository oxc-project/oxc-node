use napi::Either;
use napi_derive::napi;
use std::fmt::Write;

#[napi]
pub fn get_types_from_wasm(input: Either<String, &[u8]>) -> String {
    let wasm_module = walrus::Module::from_buffer(input.as_ref()).unwrap();
    let mut d_ts = String::new();

    for walrus::Export { name, item, .. } in wasm_module.exports.iter() {
        if let walrus::ExportItem::Function(func) = item {
            let func_type = wasm_module.types.get(wasm_module.funcs.get(*func).ty());

            write!(&mut d_ts, "export function {}(", name).unwrap();

            for (i, param) in func_type.params().iter().enumerate() {
                if i > 0 {
                    write!(&mut d_ts, ", ").unwrap();
                }
                write!(&mut d_ts, "param{}: {}", i, wasm_type_to_ts(param)).unwrap();
            }

            write!(&mut d_ts, "): ").unwrap();

            match func_type.results().len() {
                0 => write!(&mut d_ts, "void").unwrap(),
                1 => write!(&mut d_ts, "{}", wasm_type_to_ts(&func_type.results()[0])).unwrap(),
                _ => {
                    write!(&mut d_ts, "[").unwrap();
                    for (i, result) in func_type.results().iter().enumerate() {
                        if i > 0 {
                            write!(&mut d_ts, ", ").unwrap();
                        }
                        write!(&mut d_ts, "{}", wasm_type_to_ts(result)).unwrap();
                    }
                    write!(&mut d_ts, "]").unwrap();
                }
            }

            writeln!(&mut d_ts, ";").unwrap();
        }
    }

    d_ts
}

fn wasm_type_to_ts(ty: &walrus::ValType) -> &'static str {
    match ty {
        walrus::ValType::I32 => "number",
        walrus::ValType::I64 => "bigint",
        walrus::ValType::F32 => "number",
        walrus::ValType::F64 => "number",
        walrus::ValType::V128 => "BigInt64Array",
        walrus::ValType::Ref(_) => "any",
    }
}
