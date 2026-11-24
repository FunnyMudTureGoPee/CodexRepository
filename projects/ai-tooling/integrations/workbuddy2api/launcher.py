#!/usr/bin/env python3
"""workbuddy2api 一键启动器。

一次拉起「协议转换服务」和「Caddy 反向代理」：
  1. 前置检查（虚拟环境 / 配置 / Caddy / 端口冲突）
  2. 启动应用，轮询 /health 直到就绪
  3. 启动反向代理，轮询 /health 直到就绪
  4. 自动打开管理后台

停止方式：在本窗口按 Ctrl+C，或直接关闭窗口（子进程随控制台一起结束）。

用法：
    start-all.bat                                  # 双击即可
    .venv\\Scripts\\python.exe launcher.py [--no-browser] [--skip-proxy]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV_PY = ROOT / ".venv" / "Scripts" / "python.exe"
ENV_FILE = ROOT / ".env.local"
CADDYFILE = ROOT / "deploy" / "local" / "Caddyfile"
APP_ENTRY = ROOT / "run-local.py"
PID_FILE = ROOT / "local-data" / "launcher.pid"

# 绕开系统代理，否则本机回环请求可能被 HTTP_PROXY 劫持成 502
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_LOCK = threading.Lock()


def say(text: str = "") -> None:
    with _LOCK:
        print(text, flush=True)


def pause_on_error() -> None:
    """双击运行时保留窗口，方便看清报错；非交互环境直接返回。"""
    try:
        if not sys.stdin or not sys.stdin.isatty():
            return
        input("\n按回车键关闭窗口 ... ")
    except (EOFError, KeyboardInterrupt, OSError):
        pass


# --------------------------------------------------------------------------
# 配置读取与探测
# --------------------------------------------------------------------------


def load_env(path: Path) -> dict:
    values: dict = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def find_caddy() -> Path | None:
    candidates = []
    if os.environ.get("CADDY_EXE"):
        candidates.append(Path(os.environ["CADDY_EXE"]))
    candidates.append(ROOT.parent / "tools" / "caddy" / "caddy.exe")
    found = shutil.which("caddy")
    if found:
        candidates.append(Path(found))
    return next((c for c in candidates if c.is_file()), None)


def site_port(caddyfile: Path) -> int | None:
    """从 Caddyfile 读出第一个站点监听的端口。"""
    if not caddyfile.is_file():
        return None
    for line in caddyfile.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^(?:https?://)?([^\s{]+)\s*\{", stripped)
        if not match:
            continue
        address = match.group(1)
        if address.startswith(":"):
            return int(address[1:])
        if ":" in address:
            try:
                return int(address.rsplit(":", 1)[1])
            except ValueError:
                return 443
        return 443
    return None


def upstream_port(caddyfile: Path) -> int | None:
    """从 Caddyfile 读出 reverse_proxy 指向的上游端口。"""
    if not caddyfile.is_file():
        return None
    for line in caddyfile.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^reverse_proxy\s+([^\s{]+)", stripped)
        if match:
            target = match.group(1)
            if ":" in target:
                try:
                    return int(target.rsplit(":", 1)[1])
                except ValueError:
                    return None
    return None


def port_busy(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with _OPENER.open(url, timeout=timeout) as resp:
            return getattr(resp, "status", 200) == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def fetch_models(base_url: str, api_key: str, timeout: float = 20.0) -> list[str]:
    """用客户端 Key 拉一次模型列表，既能展示也顺带证明整条链路是通的。"""
    if not api_key:
        return []
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/models",
        headers={"Authorization": "Bearer " + api_key},
    )
    try:
        with _OPENER.open(request, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return []
    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    return [str(item["id"]) for item in items if isinstance(item, dict) and item.get("id")]


def account_summary(env: dict) -> str:
    """直接读管理数据文件，不需要管理会话。"""
    root = Path(env.get("MANAGEMENT_DATA_DIR") or (ROOT / "local-data" / "management"))
    state = root / "state.json"
    if not state.is_file():
        return "未初始化"
    try:
        data = json.loads(state.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return "读取失败"
    accounts = data.get("accounts")
    if not isinstance(accounts, dict) or not accounts:
        return "0 个（需在管理后台导入账号）"
    enabled = [item for item in accounts.values() if isinstance(item, dict) and item.get("enabled")]
    text = f"{len(enabled)}/{len(accounts)} 个已启用"
    active = accounts.get(data.get("active"))
    if isinstance(active, dict) and active.get("name"):
        text += f"，当前「{active['name']}」"
    return text


def print_info(entry_port: int, app_host: str, app_port: int, proxy_active: bool, env: dict) -> None:
    """就绪后打印关键信息：反代地址、API 地址、客户端 Key 等。"""
    base = f"http://127.0.0.1:{entry_port}"
    api_key = env.get("CODEBUDDY2OPENAI_KEY", "").strip()
    direct = f"http://{app_host}:{app_port}"
    width = 70
    admin_key = env.get("ADMIN_KEY", "").strip()

    say("=" * width)
    say("  服务已就绪")
    say("=" * width)
    say()
    say(f"  管理后台        {base}/admin/")
    say(f"  反代 API 基址   {base}/v1")
    if proxy_active and entry_port != app_port:
        say(f"  直连 API 基址   {direct}/v1")
    say()
    say(f"  客户端 Key      {api_key or '(未配置，请检查 .env.local)'}")
    say(f"  管理密钥        {admin_key or '(未配置，请检查 .env.local)'}")
    say(f"  账号池          {account_summary(env)}")

    models = fetch_models(base, api_key)
    if models:
        preview = "、".join(models[:6])
        suffix = f" 等 {len(models)} 个" if len(models) > 6 else ""
        say(f"  可用模型        {preview}{suffix}")
    elif api_key:
        say("  可用模型        获取失败，请确认客户端 Key 与账号状态")
    else:
        say("  可用模型        未配置客户端 Key，无法查询")

    say()
    say("  -- 客户端填写 " + "-" * (width - 16))
    say(f"  OpenAI 协议     base_url = {base}/v1")
    say(f"  Anthropic 协议  base_url = {base}       (POST /v1/messages)")
    say(f"  鉴权            Authorization: Bearer {api_key or '<客户端 Key>'}")
    say("  Codex CLI       wire_api = \"responses\"，模型如 glm-5.2")


# --------------------------------------------------------------------------
# 子进程管理
# --------------------------------------------------------------------------


def pump(stream, tag: str) -> None:
    """把子进程输出按行加上前缀转发到本窗口，避免多进程日志混在一起。"""
    try:
        for line in iter(stream.readline, ""):
            text = line.rstrip()
            if text:
                say(f"{tag} {text}")
    except (ValueError, OSError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def spawn(cmd: list[str], env: dict, tag: str) -> subprocess.Popen:
    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    threading.Thread(target=pump, args=(proc.stdout, tag), daemon=True).start()
    return proc


def wait_ready(url: str, label: str, timeout: float, proc: subprocess.Popen) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if http_ok(url):
            return True
        if proc.poll() is not None:
            say(f"  !! {label}进程已退出（退出码 {proc.returncode}），请检查上面的日志")
            return False
        time.sleep(0.4)
    say(f"  !! 等待{label}就绪超时（{timeout:.0f}s）")
    return False


def stop(proc: subprocess.Popen | None, label: str) -> None:
    if proc is None or proc.poll() is not None:
        return
    say(f"  · 正在停止{label} ...")
    try:
        proc.terminate()
    except OSError:
        return
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass


def write_pidfile(app: subprocess.Popen | None, proxy: subprocess.Popen | None) -> None:
    try:
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(
            json.dumps(
                {
                    "app": app.pid if app else None,
                    "proxy": proxy.pid if proxy else None,
                }
            ),
            encoding="utf-8",
        )
    except OSError:
        pass


def clear_pidfile() -> None:
    try:
        PID_FILE.unlink(missing_ok=True)
    except OSError:
        pass


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    parser = argparse.ArgumentParser(description="workbuddy2api 一键启动器")
    parser.add_argument("--no-browser", action="store_true", help="就绪后不自动打开浏览器")
    parser.add_argument("--skip-proxy", action="store_true", help="只启动应用，不启动反向代理")
    args = parser.parse_args()

    env_file = load_env(ENV_FILE)
    app_host = os.environ.get("HOST") or env_file.get("HOST") or "127.0.0.1"
    try:
        app_port = int(os.environ.get("PORT") or env_file.get("PORT") or 8787)
    except ValueError:
        app_port = 8787

    say("=" * 58)
    say("  workbuddy2api 一键启动器")
    say("=" * 58)
    say()

    # ---------- 前置检查 ----------
    problems: list[str] = []
    if not VENV_PY.is_file():
        problems.append(
            f"未找到虚拟环境：{VENV_PY}\n"
            f"      请先执行： uv venv .venv   然后  uv pip install -r requirements.txt"
        )
    if not APP_ENTRY.is_file():
        problems.append(f"未找到应用入口：{APP_ENTRY}")
    if not ENV_FILE.is_file():
        problems.append(f"未找到配置文件：{ENV_FILE}")

    caddy = None
    proxy_port = None
    if not args.skip_proxy:
        caddy = find_caddy()
        if caddy is None:
            problems.append("未找到 caddy.exe（可设置环境变量 CADDY_EXE 指定路径）")
        if not CADDYFILE.is_file():
            problems.append(f"未找到反向代理配置：{CADDYFILE}")
        else:
            proxy_port = site_port(CADDYFILE) or 8080
            target = upstream_port(CADDYFILE)
            if target is not None and target != app_port:
                problems.append(
                    f"配置不一致：Caddyfile 转发到 {target}，但应用监听 {app_port}\n"
                    f"      请把 {CADDYFILE} 里的 reverse_proxy 改成 127.0.0.1:{app_port}，"
                    f"或把 .env.local 的 PORT 改成 {target}"
                )
            if proxy_port == app_port:
                problems.append(f"端口冲突：反向代理与应用都配置为 {app_port}")

    if problems:
        say("启动前检查未通过：")
        for index, item in enumerate(problems, 1):
            say(f"  {index}. {item}")
        say()
        pause_on_error()
        return 1

    say(f"  应用目录： {ROOT}")
    say(f"  应用入口： {app_host}:{app_port}")
    if not args.skip_proxy:
        say(f"  反向代理： 127.0.0.1:{proxy_port}")
    say()

    app_proc: subprocess.Popen | None = None
    proxy_proc: subprocess.Popen | None = None

    # ---------- 启动应用 ----------
    if port_busy(app_port, app_host):
        say(f"  · 端口 {app_port} 已在监听，复用现有服务")
    else:
        say("  · 正在启动协议转换服务 ...")
        app_env = dict(os.environ)
        app_env["PYTHONUNBUFFERED"] = "1"
        app_proc = spawn([str(VENV_PY), str(APP_ENTRY)], app_env, "[app]")
        if not wait_ready(f"http://{app_host}:{app_port}/health", "协议转换服务", 90, app_proc):
            stop(app_proc, "协议转换服务")
            say()
            pause_on_error()
            return 1
        say(f"    OK  已就绪  http://{app_host}:{app_port}")

    # ---------- 启动反向代理 ----------
    if not args.skip_proxy:
        if port_busy(proxy_port):
            say(f"  · 端口 {proxy_port} 已在监听，复用现有反向代理")
        else:
            say("  · 正在启动反向代理 ...")
            proxy_env = dict(os.environ)
            proxy_env["XDG_DATA_HOME"] = str(ROOT / "local-data" / "caddy" / "data")
            proxy_env["XDG_CONFIG_HOME"] = str(ROOT / "local-data" / "caddy" / "config")
            proxy_proc = spawn(
                [str(caddy), "run", "--config", str(CADDYFILE), "--adapter", "caddyfile"],
                proxy_env,
                "[proxy]",
            )
            if wait_ready(f"http://127.0.0.1:{proxy_port}/health", "反向代理", 45, proxy_proc):
                say(f"    OK  已就绪  http://127.0.0.1:{proxy_port}")
            else:
                say("    !  反向代理未就绪，已跳过；应用本身仍可直接访问")
                stop(proxy_proc, "反向代理")
                proxy_proc = None

    if app_proc is not None or proxy_proc is not None:
        write_pidfile(app_proc, proxy_proc)

    # 反代是否可用：可能是本次启动的，也可能是先前就已在监听的
    proxy_active = proxy_proc is not None or (
        not args.skip_proxy and proxy_port is not None and port_busy(proxy_port)
    )
    entry_port = proxy_port if proxy_active else app_port
    admin_url = f"http://127.0.0.1:{entry_port}/admin/"

    say()
    print_info(entry_port, app_host, app_port, proxy_active, env_file)
    say()

    if not args.no_browser:
        try:
            webbrowser.open(admin_url)
        except Exception:
            pass

    if app_proc is None and proxy_proc is None:
        say("  服务已在运行，本启动器直接退出（已为你打开管理后台）。")
        return 0

    say("-" * 70)
    say("  按 Ctrl+C 停止本次启动的服务（关闭窗口同样可以）")
    say("-" * 70)
    say()

    # ---------- 守护 ----------
    try:
        while app_proc is not None or proxy_proc is not None:
            time.sleep(1)
            if app_proc is not None and app_proc.poll() is not None:
                say(f"  !! 协议转换服务已退出（退出码 {app_proc.returncode}）")
                app_proc = None
            if proxy_proc is not None and proxy_proc.poll() is not None:
                say(f"  !! 反向代理已退出（退出码 {proxy_proc.returncode}）")
                proxy_proc = None
    except KeyboardInterrupt:
        say()
        say("  收到停止信号，正在收尾 ...")
    finally:
        stop(proxy_proc, "反向代理")
        stop(app_proc, "协议转换服务")
        clear_pidfile()

    say("  已全部停止。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
