//! A small JSON-like value tree with CBOR and JSON writers: just enough to
//! produce a Serum preset without pulling in serialisation crates.

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(String),
    List(Vec<Value>),
    /// An array of single-precision floats, each written as a CBOR float32
    /// (how Serum stores the samples of an embedded wavetable).
    F32s(Vec<f32>),
    /// Key order does not matter here; writers sort the keys.
    Map(Vec<(String, Value)>),
}

impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Value::Bool(v)
    }
}
impl From<i64> for Value {
    fn from(v: i64) -> Self {
        Value::Int(v)
    }
}
impl From<f64> for Value {
    fn from(v: f64) -> Self {
        Value::Num(v)
    }
}
impl From<f32> for Value {
    fn from(v: f32) -> Self {
        // Go through the shortest decimal form so single-precision 0.7 is
        // written as 0.7 rather than 0.699999988079071.
        Value::Num(v.to_string().parse().unwrap_or(v as f64))
    }
}
impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Value::Str(v.to_string())
    }
}
impl From<String> for Value {
    fn from(v: String) -> Self {
        Value::Str(v)
    }
}
impl From<Vec<Value>> for Value {
    fn from(v: Vec<Value>) -> Self {
        Value::List(v)
    }
}

/// Builds a map: `map(vec![("key", value.into()), ...])`.
pub fn map(pairs: Vec<(&str, Value)>) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

pub fn empty() -> Value {
    Value::Map(Vec::new())
}

impl Value {
    /// Inserts or replaces a key (only meaningful on maps).
    pub fn set(&mut self, key: &str, value: Value) {
        if let Value::Map(pairs) = self {
            match pairs.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => pairs.push((key.to_string(), value)),
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Map(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn sorted(pairs: &[(String, Value)]) -> Vec<&(String, Value)> {
        let mut v: Vec<&(String, Value)> = pairs.iter().collect();
        v.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        v
    }

    // --- CBOR (RFC 8949) -----------------------------------------------------

    pub fn to_cbor(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.write_cbor(&mut out);
        out
    }

    fn write_cbor(&self, out: &mut Vec<u8>) {
        match self {
            Value::Null => out.push(0xf6),
            Value::Bool(b) => out.push(if *b { 0xf5 } else { 0xf4 }),
            Value::Int(i) => {
                if *i >= 0 {
                    head(out, 0, *i as u64);
                } else {
                    head(out, 1, (-1 - *i) as u64);
                }
            }
            Value::Num(f) => {
                out.push(0xfb);
                out.extend_from_slice(&f.to_bits().to_be_bytes());
            }
            Value::Str(s) => {
                head(out, 3, s.len() as u64);
                out.extend_from_slice(s.as_bytes());
            }
            Value::List(items) => {
                head(out, 4, items.len() as u64);
                for v in items {
                    v.write_cbor(out);
                }
            }
            Value::F32s(items) => {
                head(out, 4, items.len() as u64);
                out.reserve(items.len() * 5);
                for v in items {
                    out.push(0xfa);
                    out.extend_from_slice(&v.to_bits().to_be_bytes());
                }
            }
            Value::Map(pairs) => {
                head(out, 5, pairs.len() as u64);
                for (k, v) in Self::sorted(pairs) {
                    head(out, 3, k.len() as u64);
                    out.extend_from_slice(k.as_bytes());
                    v.write_cbor(out);
                }
            }
        }
    }

    // --- JSON ----------------------------------------------------------------

    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }

    fn write_json(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Int(i) => out.push_str(&i.to_string()),
            Value::Num(f) => {
                if !f.is_finite() {
                    out.push('0');
                } else if f.fract() == 0.0 && f.abs() < 1e15 {
                    // Keep the ".0" so the value stays a float for the reader.
                    out.push_str(&format!("{f:.1}"));
                } else {
                    out.push_str(&f.to_string());
                }
            }
            Value::Str(s) => json_string(out, s),
            Value::List(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write_json(out);
                }
                out.push(']');
            }
            Value::F32s(items) => {
                let items: Vec<Value> = items.iter().map(|v| Value::Num(*v as f64)).collect();
                Value::List(items).write_json(out);
            }
            Value::Map(pairs) => {
                out.push('{');
                for (i, (k, v)) in Self::sorted(pairs).into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    json_string(out, k);
                    out.push(':');
                    v.write_json(out);
                }
                out.push('}');
            }
        }
    }
}

fn head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8);
    } else if n <= 0xff {
        out.push(m | 24);
        out.push(n as u8);
    } else if n <= 0xffff {
        out.push(m | 25);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n <= 0xffff_ffff {
        out.push(m | 26);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

fn json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cbor_matches_rfc_examples() {
        assert_eq!(Value::Int(0).to_cbor(), [0x00]);
        assert_eq!(Value::Int(23).to_cbor(), [0x17]);
        assert_eq!(Value::Int(24).to_cbor(), [0x18, 0x18]);
        assert_eq!(Value::Int(1000).to_cbor(), [0x19, 0x03, 0xe8]);
        assert_eq!(Value::Int(1_000_000).to_cbor(), [0x1a, 0x00, 0x0f, 0x42, 0x40]);
        assert_eq!(Value::Int(-1).to_cbor(), [0x20]);
        assert_eq!(Value::Int(-100).to_cbor(), [0x38, 0x63]);
        assert_eq!(Value::Num(1.1).to_cbor(), [0xfb, 0x3f, 0xf1, 0x99, 0x99, 0x99, 0x99, 0x99, 0x9a]);
        assert_eq!(Value::Bool(true).to_cbor(), [0xf5]);
        assert_eq!(Value::Null.to_cbor(), [0xf6]);
        assert_eq!(Value::F32s(vec![1.5, -0.25]).to_cbor(), [0x82, 0xfa, 0x3f, 0xc0, 0, 0, 0xfa, 0xbe, 0x80, 0, 0]);
        assert_eq!(Value::from("IETF").to_cbor(), [0x64, 0x49, 0x45, 0x54, 0x46]);
        assert_eq!(Value::List(vec![Value::Int(1), Value::Int(2), Value::Int(3)]).to_cbor(), [0x83, 1, 2, 3]);
        // {"a": 1, "b": [2, 3]}, given out of order to check sorting.
        let m = map(vec![("b", Value::List(vec![Value::Int(2), Value::Int(3)])), ("a", Value::Int(1))]);
        assert_eq!(m.to_cbor(), [0xa2, 0x61, 0x61, 0x01, 0x61, 0x62, 0x82, 0x02, 0x03]);
    }

    #[test]
    fn json_output() {
        let m = map(vec![
            ("version", 9.0f64.into()),
            ("tags", Value::List(vec!["Wavetable".into(), "Poly".into()])),
            ("name", "a \"b\"\n音".into()),
            ("n", Value::Int(-3)),
            ("x", 0.25f64.into()),
        ]);
        assert_eq!(m.to_json(), r#"{"n":-3,"name":"a \"b\"\n音","tags":["Wavetable","Poly"],"version":9.0,"x":0.25}"#);
    }

    #[test]
    fn f32_values_are_cleaned() {
        assert_eq!(Value::from(0.7f32), Value::Num(0.7));
        assert_eq!(Value::from(66.6f32), Value::Num(66.6));
    }

    #[test]
    fn set_replaces_existing_keys() {
        let mut m = map(vec![("a", Value::Int(1))]);
        m.set("a", Value::Int(2));
        m.set("b", Value::Int(3));
        assert_eq!(m.get("a"), Some(&Value::Int(2)));
        assert_eq!(m.get("b"), Some(&Value::Int(3)));
    }
}
