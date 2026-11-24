"""
http_client.py — 基于 urllib 的轻量 HTTP 客户端, 提供重试/退避/超时/可配置 Header。

仅依赖标准库, 无需安装第三方包。错误以异常形式抛出, 由调用方决定
是把结果写入 lyrics JSONL 还是 errors JSONL。
"""
from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional
from urllib.parse import urlencode

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

RETRYABLE_HTTP = frozenset({429, 500, 502, 503, 504})
MAX_RETRIES = 3
BASE_DELAY = 1.2


@dataclass
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    text: str
    url: str

    def json(self) -> Any:
        return json.loads(self.text)


class HttpError(Exception):
    def __init__(self, status: int, message: str, retry_after: Optional[int] = None, url: str = ""):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after
        self.url = url


class FetchError(Exception):
    """网络层失败(连接、超时、解码)。"""


@dataclass
class HttpClient:
    headers: Mapping[str, str] = field(default_factory=dict)
    timeout: int = 20
    max_retries: int = MAX_RETRIES
    base_delay: float = BASE_DELAY
    user_agent: str = DEFAULT_UA

    def _build_request(self, url: str, method: str = "GET", data: Optional[Mapping[str, Any]] = None) -> urllib.request.Request:
        hdrs = dict(self.headers)
        hdrs.setdefault("User-Agent", self.user_agent)
        body = None
        if method == "POST":
            if data is not None:
                body = urlencode(data).encode("utf-8")
                hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        return req

    def _sleep(self, attempt: int, retry_after: Optional[int] = None) -> None:
        if retry_after and retry_after > 0:
            time.sleep(min(float(retry_after), 30.0))
        else:
            delay = self.base_delay * (2 ** attempt) + random.uniform(0.0, 0.6)
            time.sleep(min(delay, 15.0))

    def request(
        self,
        url: str,
        method: str = "GET",
        data: Optional[Mapping[str, Any]] = None,
        timeout: Optional[int] = None,
    ) -> HttpResponse:
        timeout = timeout or self.timeout
        last_err: Exception | None = None
        last_retry_after: Optional[int] = None
        for attempt in range(self.max_retries + 1):
            req = self._build_request(url, method, data)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                    raw = resp.read()
                    encoding = (resp.headers.get("Content-Type") or "").lower()
                    if "charset=" in encoding:
                        enc = encoding.split("charset=")[1].split(";")[0].strip() or "utf-8"
                    else:
                        enc = "utf-8"
                    try:
                        text = raw.decode(enc, errors="replace")
                    except (LookupError, UnicodeDecodeError):
                        text = raw.decode("utf-8", errors="replace")
                    return HttpResponse(int(resp.status), dict(resp.headers), text, url)
            except urllib.error.HTTPError as e:
                code = int(e.code)
                body = "".join(e.read().decode("utf-8", errors="replace")[:800])
                retry_after = None
                ra = e.headers.get("Retry-After")
                if ra:
                    try:
                        retry_after = int(ra)
                    except ValueError:
                        retry_after = None
                last_retry_after = retry_after
                if code in RETRYABLE_HTTP and attempt < self.max_retries:
                    last_err = HttpError(code, body, retry_after, url)
                    self._sleep(attempt, retry_after)
                    continue
                raise HttpError(code, body or f"HTTP {code}", retry_after, url) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last_err = FetchError(f"{type(e).__name__}: {e}")
                if attempt < self.max_retries:
                    self._sleep(attempt, None)
                    continue
                raise FetchError(f"{type(e).__name__}: {e}") from None
        # 理论上不可达
        raise last_err  # type: ignore[misc]

    def get(self, url: str, **kw) -> HttpResponse:
        return self.request(url, "GET", **kw)

    def get_json(self, url: str, **kw) -> Any:
        return self.get(url, **kw).json()

    def get_text(self, url: str, **kw) -> str:
        return self.get(url, **kw).text
