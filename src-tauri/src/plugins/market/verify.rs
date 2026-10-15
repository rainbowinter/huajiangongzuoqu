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

/// 验签通过之后，取出签名里的 **trusted comment**。
///
/// ⚠️ 顺序不能反：minisign 的 global signature 覆盖了这段注释，而 `verify` 正是校验它
/// 那一步。**先读注释就等于信任了攻击者可控的数据。** updater 源码里专门有一句注释
/// 强调这点，这里照做。
///
/// 市场用它放清单的版本号，做防回滚（见 `Docs/plugin-market.md`）。
pub fn verified_trusted_comment(
    data: &[u8],
    signature_base64: &str,
    pubkey_base64: &str,
) -> Result<String, AppError> {
    let public_key = PublicKey::decode(&decode_base64_to_text(pubkey_base64)?)
        .map_err(|error| err(format!("公钥解析失败：{error}")))?;
    let signature = Signature::decode(&decode_base64_to_text(signature_base64)?)
        .map_err(|error| err(format!("签名解析失败：{error}")))?;

    public_key
        .verify(data, &signature, true)
        .map_err(|error| err(format!("验签不通过：{error}")))?;

    Ok(signature.trusted_comment().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 阶段 0 的实测夹具：用一把**测试密钥**（`market-test.key`，只在本机临时生成、
    /// 与生产私钥无关）签的一段最小清单。
    ///
    /// 私钥没有进仓库；这里只有「原文 + 签名 + 公钥」，够验证配方，也够当成格式的回归锚点。
    const CATALOG: &str = "{\n  \"schema\": 1,\n  \"catalogVersion\": 1,\n  \"plugins\": []\n}\n";

    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRbXgyaWpFY1dvR1ppK3JJODAweFM5UW5qZS9ra3AvRzE4UmRQN1hwSi9ZMUJuZFduYWN2VjVuVG1icGpvN3RnM0hxYlNrQmxHTjZhdENDcktPWWV2WkFqMkhObjRoK1FZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMDU0NDkwCWZpbGU6cGx1Z2luLWNhdGFsb2cuanNvbgpDU2NtNEtYR1F4SUpwSDdscnV5bkhvL0FpL1UxMUp6NVdNM2dvZ2pLTmtNTXI3Tmo4VlRKVS9zN3g4YkVqUmVPSWUwcW9RcUZDL1YvS2trOHJWOUdDQT09Cg==";

    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE5QThDNTExQTM2OEM3MjYKUldRbXgyaWpFY1dvR1JFQmN5eXM0MHNZNXprN2xrSm9FUURNdEt0NzcxdlNoMmJuKy9SMkcya3AK";

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

    #[test]
    fn trusted_comment_is_only_readable_after_verification() {
        // 验签通过才拿得到它。
        let comment = verified_trusted_comment(CATALOG.as_bytes(), SIGNATURE, PUBKEY)
            .expect("验签通过后应当读得到 trusted comment");
        assert!(comment.contains("timestamp"), "实际拿到：{comment}");

        // 内容被改过就不该给出任何注释。
        let tampered = CATALOG.replace("[]", "[\"x\"]");
        assert!(verified_trusted_comment(tampered.as_bytes(), SIGNATURE, PUBKEY).is_err());
    }
}
