//! 只在测试里编译的小工具：一个最小 HTTP 服务器，外加阶段 0 那份签名夹具。
//!
//! ## 为什么要真起一个服务器
//!
//! 下载那一段（`reqwest` → 边下边算 sha256 → 截断读防炸）是**只有跑起来才测得到**的。
//! 把 zip 直接写进工作区会让那一整段空着，而它恰好是「装进来一个来路不明的东西」这条
//! 路上最该被验证的部分。服务器线程自己记下每个请求的路径 —— 测试就能断言「**真的**去
//! 取了 .sig / 真的发起了下载」，而不是只看结果。
//!
//! 只在回环地址上监听，端到端也用回环（`release_url_is_allowed` 特意给本地测试留了
//! http 的口子）。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// 阶段 0 实测过的那份最小清单：用一把**测试密钥**签的（私钥不在仓库里）。
///
/// 用固定夹具而不是测试时现签：现签要引入签名库，而这里要验的是「取回 → 验签」这条链路，
/// 不是签名算法本身。
pub const SIGNED_CATALOG: &str =
    "{\n  \"schema\": 1,\n  \"catalogVersion\": 1,\n  \"plugins\": []\n}\n";

pub const CATALOG_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRbXgyaWpFY1dvR1ppK3JJODAweFM5UW5qZS9ra3AvRzE4UmRQN1hwSi9ZMUJuZFduYWN2VjVuVG1icGpvN3RnM0hxYlNrQmxHTjZhdENDcktPWWV2WkFqMkhObjRoK1FZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMDU0NDkwCWZpbGU6cGx1Z2luLWNhdGFsb2cuanNvbgpDU2NtNEtYR1F4SUpwSDdscnV5bkhvL0FpL1UxMUp6NVdNM2dvZ2pLTmtNTXI3Tmo4VlRKVS9zN3g4YkVqUmVPSWUwcW9RcUZDL1YvS2trOHJWOUdDQT09Cg==";

pub const CATALOG_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE5QThDNTExQTM2OEM3MjYKUldRbXgyaWpFY1dvR1JFQmN5eXM0MHNZNXprN2xrSm9FUURNdEt0NzcxdlNoMmJuKy9SMkcya3AK";

/// 绑在回环上的最小 HTTP 服务器：一个请求一个连接，`Connection: close`。
pub struct TestServer {
    /// 形如 `http://127.0.0.1:54321`（没有结尾斜杠）。
    pub base: String,
    hits: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl TestServer {
    /// `routes` 是「路径 → 响应体」。路径要带前导斜杠。
    pub fn start(routes: Vec<(String, Vec<u8>)>) -> Self {
        let routes: BTreeMap<String, Vec<u8>> = routes.into_iter().collect();
        // 端口写 0，让系统分配一个空闲端口 —— 测试之间不会撞车。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("local addr");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking");

        let hits = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let thread_hits = Arc::clone(&hits);
        let thread_stop = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &routes, &thread_hits),
                    Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        // 非阻塞轮询：这样 `Drop` 不必再连一次来把 accept 叫醒。
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            base: format!("http://{address}"),
            hits,
            stop,
            handle: Some(handle),
        }
    }

    /// 服务器收到过的请求路径，按顺序。
    pub fn hits(&self) -> Vec<String> {
        self.hits.lock().expect("hits lock").clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve(
    mut stream: TcpStream,
    routes: &BTreeMap<String, Vec<u8>>,
    hits: &Arc<Mutex<Vec<String>>>,
) {
    // ⚠️ **必须显式设回阻塞**。Windows 上 `accept` 出来的 socket 会**继承监听 socket 的
    // 非阻塞模式**（Linux 不继承），不设的话请求字节还没到、`read` 就立刻返回
    // `WouldBlock`，于是连接被空手关掉，客户端报一句没头没脑的
    // 「error sending request for url」——踩过一次。
    let _ = stream.set_nonblocking(false);
    // 客户端连上却不说话时别把服务器线程钉死（客户端出错时就会这样）。
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    // 只读请求头就够了：这里的请求全是 GET。
    let mut raw = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        let Ok(read) = stream.read(&mut buffer) else {
            return;
        };
        if read == 0 {
            return;
        }
        raw.extend_from_slice(&buffer[..read]);
        if raw.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let request = String::from_utf8_lossy(&raw);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_string();

    hits.lock().expect("hits lock").push(path.clone());

    let response = match routes.get(&path) {
        Some(body) => {
            let mut head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            head.extend_from_slice(body);
            head
        }
        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec(),
    };

    let _ = stream.write_all(&response);
    let _ = stream.flush();
}
