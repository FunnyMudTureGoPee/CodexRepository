"""本机启动器：读取 .env.local，把管理后台 + API 绑定到 127.0.0.1。

上游 admin/server.py 的 __main__ 硬编码 host=0.0.0.0，
这里改为默认只监听回环地址，避免服务被局域网访问。

用法：
    .venv\\Scripts\\python.exe run-local.py
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        # 已存在的真实环境变量优先，不覆盖
        os.environ.setdefault(key.strip(), value.strip())


load_env(ROOT / ".env.local")

import uvicorn  # noqa: E402
from admin.server import create_app  # noqa: E402

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "0").strip().lower() in {"1", "true", "yes", "on"}

# 请求日志。admin/server.py 里会把 converter.CONFIG["log_path"] 置成 None，
# 所以必须在 create_app() 之后重新打开。
# 注意：日志会记录模型名、上游返回体、以及最后 30 行原始 SSE（可能含对话内容），
# 只写在本机 local-data 下。用 WB_LOG=0 关闭。
WB_LOG = os.environ.get("WB_LOG", "").strip() or str(ROOT / "local-data" / "requests.log")


def enable_request_log() -> None:
    if WB_LOG.lower() in {"0", "off", "false", "no"}:
        return
    try:
        import core.converter as converter
        Path(WB_LOG).parent.mkdir(parents=True, exist_ok=True)
        converter.CONFIG["log_path"] = WB_LOG
    except Exception as exc:  # noqa: BLE001
        print(f"[!] 请求日志未开启: {exc}", file=sys.stderr)


if __name__ == "__main__":
    app = create_app(secure_cookie=SECURE_COOKIE)
    enable_request_log()
    if WB_LOG.lower() not in {"0", "off", "false", "no"}:
        print(f"请求日志: {WB_LOG}")
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level=os.environ.get("LOG_LEVEL", "info"),
        proxy_headers=True,
        # 只有本机反向代理可信，不要用 "*"
        forwarded_allow_ips="127.0.0.1",
    )
