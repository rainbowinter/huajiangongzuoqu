//! 市场清单的验签。
//!
//! ## 为什么清单必须签名
//!
//! 清单里写着「插件 X 的下载地址」和「它的 sha256」。如果清单本身不可信，那两者都可以被
//! 一起换掉 —— 校验 sha256 只挡得住传输途中的损坏，挡不住源头被替换。签名把
//! 「装进来的东西」钉死到**私钥持有者**：清单被改一个字节，验签就失败。
//!
//! 用的是与应用自更新**同一套 minisign 密钥体系**（公钥在配置里，私钥在打包/发布者的
//! 机器上），但配置字段独立，将来想单独轮换插件密钥只需改一处。
//!
//! ## 编码有两层，别搞混
//!
//! * 配置里的公钥、以及 `.sig` 文件里的签名，都是**标准 minisign 文本的 base64**；
//! * `PublicKey::decode` / `Signature::decode` 要的是**解码之后的那段文本**。
//!
//! 配方照抄 `tauri-plugin-updater` 的 `verify_signature`（那是这条路唯一被验证过的实现）。

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

use crate::services::notes::AppError;

fn err(message: String) -> AppError {
    AppError {
        code: "marketSignatureInvalid".into(),
        message,
        details: Default::default(),
    }
}

/// base64 → 文本。两层编码里的第一层。
///
/// 解码前**去掉所有空白**（不只是两端）：签名是从 HTTP 响应体或文件里读出来的，尾随换行、
/// CRLF、甚至被人为折行都可能出现。base64 字母表里没有空白字符，删掉它们不会改变含义，
/// 而只 `trim` 的话，被折行的签名会直接解不出来。样本来自我们自己发布的资产，这里放宽
/// 是安全的 —— 真正的把关是后面的验签。
fn decode_base64_to_text(value: &str) -> Result<String, AppError> {
    let compact: String = value.chars().filter(|c| !c.is_whitespace()).collect();

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&compact)
        .map_err(|error| err(format!("签名/公钥不是合法的 base64：{error}")))?;

    String::from_utf8(bytes).map_err(|_| err("签名/公钥解码后不是 UTF-8".into()))
}

/// 校验一段字节确实由对应私钥签过。
pub fn verify_signed(data: &[u8], signature_base64: &str, pubkey_base64: &str) -> Result<(), AppError> {
    let public_key = PublicKey::decode(&decode_base64_to_text(pubkey_base64)?)
        .map_err(|error| err(format!("公钥解析失败：{error}")))?;
    let signature = Signature::decode(&decode_base64_to_text(signature_base64)?)
        .map_err(|error| err(format!("签名解析失败：{error}")))?;

    // 第三个参数 `allow_legacy`：与 updater 保持一致（它传 true）。
    public_key
        .verify(data, &signature, true)
        .map_err(|error| err(format!("验签不通过：{error}")))
}

// 关于签名里的 `trusted_comment`（曾经打算把清单版本号放在那里做防回滚）：
//
// 1. **读它必须排在 `verify` 之后**。minisign 的 global signature 覆盖了这段注释，
//    而 `verify` 正是校验它的那一步 —— 先读就等于信任了攻击者可控的数据。updater 的源码
//    里专门有一句注释强调这点。
// 2. 但**我们没法往里放东西**：`tauri signer sign` 自己写那段注释（`timestamp:… file:…`），
//    没有留下塞自定义内容的参数。于是 `catalogVersion` 直接放在清单 JSON 里 ——
//    正文整段都被签名覆盖，同样可信，还少一层解析。理由写在 `catalog.rs` 顶部。

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::testkit::{
        CATALOG_PUBKEY as PUBKEY, CATALOG_SIGNATURE as SIGNATURE, SIGNED_CATALOG as CATALOG,
    };

    #[test]
    fn accepts_a_signature_from_the_matching_key() {
        verify_signed(CATALOG.as_bytes(), SIGNATURE, PUBKEY).expect("这份签名应当通过");
    }

    #[test]
    fn rejects_tampered_content() {
        // 只改一个字节：把 catalogVersion 从 1 改成 9。
        let tampered = CATALOG.replace("\"catalogVersion\": 1", "\"catalogVersion\": 9");

        assert!(
            verify_signed(tampered.as_bytes(), SIGNATURE, PUBKEY).is_err(),
            "改过内容的清单必须被拒 —— 这正是签名要挡的事"
        );
    }

    #[test]
    fn rejects_a_signature_from_another_key() {
        // 拿应用自更新那把生产**公钥**来验测试密钥签的东西 —— 必须失败。
        const PRODUCTION_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDlENDc3QjNFMjUxMTZFMDMKUldRRGJoRWxQbnRIbmZCR1EzUUpKcG54NjZEYWFFN1dxUEcvUGQ0ZHdveWpab2Y0UmZaaWpWOWIK";

        assert!(
            verify_signed(CATALOG.as_bytes(), SIGNATURE, PRODUCTION_PUBKEY).is_err(),
            "换一把公钥就不该通过"
        );
    }

    #[test]
    fn tolerates_whitespace_around_and_inside_the_signature() {
        // 资产被人为折行、或 HTTP 体带 CRLF 都要照样能验。
        let wrapped = format!("  {}\n\n", SIGNATURE.trim());
        verify_signed(CATALOG.as_bytes(), &wrapped, PUBKEY).expect("两端空白不该有影响");

        let folded = SIGNATURE
            .trim()
            .as_bytes()
            .chunks(64)
            .map(|chunk| std::str::from_utf8(chunk).unwrap())
            .collect::<Vec<_>>()
            .join("\r\n");
        verify_signed(CATALOG.as_bytes(), &folded, PUBKEY).expect("折行的签名也该认");
    }

    #[test]
    fn rejects_garbage_input_without_panicking() {
        assert!(verify_signed(CATALOG.as_bytes(), "不是 base64", PUBKEY).is_err());
        assert!(verify_signed(CATALOG.as_bytes(), SIGNATURE, "不是 base64").is_err());
        assert!(verify_signed(CATALOG.as_bytes(), "", "").is_err());
    }
}
