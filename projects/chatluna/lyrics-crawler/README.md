# lyrics_crawler — 歌词自动抓取程序

针对网易云音乐、QQ音乐、酷我音乐等主流音乐平台，辅以萌娘百科与 [VCPedia](https://vcpedia.cn/)，
按**可选歌手参数**自动抓取歌词并输出 **UTF-8 JSONL**（每行一首歌），可直接交给 `chatluna-lyrics-mcp` 导入。

抓取逻辑：**先拉取歌单（百科/网易云为主）** → 并行逐首抓歌词（`--workers`）→ **百科交叉验证** → **数量分页（`--page-size`）+ 跨运行去重**。

## 特性

- **仅依赖 Python 标准库**（urllib / json / hashlib / re），无需 pip 安装任何第三方包。
- 多来源并发安全、可插拔；失败会自动记入 `*.errors.jsonl`，不影响其它来源成功抓取。
- LRC 时间戳、`[ti:/ar:/al:]` 元信息、`作词/作曲/编曲/录音/混音` 等制作信息行自动剔除；
  段间空行保留并折叠为最多一行；不添加歌名/歌手/来源、不翻译、不补全。
- 输出前自动按 schema 校验（`id` 模式、必填字段、长度限制）；`--validate` 可单独校验已有文件。
- **先拉取歌单（百科为主，避免音乐平台的翻唱/版本）**，并按歌曲去重、保留优先级最高的来源；虚拟歌手可强制启用 VCPedia 按歌手检索（`--singer`）。
- **并行抓取**：`--workers`（默认 3）多线程逐首抓歌词+核验，显著提速。
- **萌娘/VCPedia 交叉验证**：每首歌在百科上核对是否命中，结果写入 `*.status.json`。
- **断点续抓**：状态实时写入 `<prefix>.state.json`，中断后加 `--resume` 继续，已完成的歌不重复查询。

## 要求

- Python 3.10+（在 3.11 下测试通过）。
- 可访问目标站点的网络（部分站点对地区/UA 有限制，见“来源可用性”）。

## 快速开始

无需安装，直接在项目根目录：

```bat
REM 示例1 抓取一个歌手的歌(默认全部来源, 百科为主, 输出到 output\a-歌手\lyrics-001.*)
python -m lyrics_crawler --artist "周杰伦"

REM 示例2 虚拟歌手: 自动用 VCPedia 分类枚举歌名, 并与网易云/QQ 合并去重
python -m lyrics_crawler --artist "洛天依" --singer

REM 示例3 精确抓某一首歌(各来源按歌名查 + 交叉验证)
python -m lyrics_crawler --query "牵丝戏" --sources vcpedia,netease,qq --limit 2

REM 示例4 控制数量: 每来源搜10首, 去重后最终最多15首
python -m lyrics_crawler --artist "洛天依" --singer --limit 10 --total 15

REM 示例5 只选音乐平台 / 只选百科
python -m lyrics_crawler --artist "周杰伦" --sources music
python -m lyrics_crawler --artist "洛天依" --singer --sources wiki

REM 示例6 两段式: 先只生成歌单, 再按歌单抓歌词
python -m lyrics_crawler --artist "洛天依" --singer --limit 100 --songs-only
REM 上一步会打印实际路径(默认 output\a-洛天依\songs.jsonl)
python -m lyrics_crawler --songs-file "output\a-洛天依\songs.jsonl"

REM 示例7 手动终止 + 断点续抓
python -m lyrics_crawler --artist "洛天依" --singer
python -m lyrics_crawler --artist "洛天依" --singer --resume

REM 示例8 校验已生成的 JSONL
python -m lyrics_crawler --validate "output\a-洛天依\lyrics-001.jsonl"

REM 示例9 静默运行 / 自定义输出目录与文件前缀
python -m lyrics_crawler --artist "洛天依" --singer --quiet
python -m lyrics_crawler --artist "洛天依" --singer --output data --prefix my-run
```

### 一键脚本（交互式）

在项目根目录双击/运行以下脚本即可（可传参数，缺省时用中文提示逐项输入）：

| 脚本 | 作用 | 示例 |
|---|---|---|
| **`menu.bat`** | **主菜单**：列出 抓取/仅歌单/从歌单/续传/终止 供你选 | 双击运行即可 |
| `crawl.bat` | **完整抓取**：拉歌单 → 抓歌词 → 交叉验证 | `crawl.bat --artist "洛天依" --singer` |
| `playlist.bat` | **仅歌单**：只生成歌单文件 | `playlist.bat --artist "洛天依" --singer --limit 100` |
| `fromlist.bat` | **从歌单生成**：基于 `.songs.jsonl` 抓歌词 | `fromlist.bat --songs-file "output\\a-洛天依\\songs.jsonl"` |
| `resume.bat` | **断点续传**：列出所有工作区供你选，续传未完成部分 | `resume.bat` |
| `interrupt.bat` | **断点终止**：向运行中的任务发停止信号 | `interrupt.bat` |
| `merge.bat` | **合并工作区**：把源工作区合并进目标工作区 | `merge.bat --from default --to a-洛天依` |

- 不带参数双击：脚本会**逐项提示**输入（歌手/歌名、来源、数量、是否虚拟歌手等），回车用默认值；
- 带参数运行：跳过对应提示，直接执行；
- `interrupt.bat`：找到最近任务、确认后写入停止信号；运行中的抓取在处理完当前首后**优雅保存并退出**，随后 `resume.bat` 断点续传。

### 参数

| 参数 | 说明 |
|---|---|
| `--artist` | 歌手名称，抓取其（按来源过滤的）歌曲 |
| `--query` | 歌名/搜索词，精确抓取某一首歌 |
| `--sources` | 逗号分隔来源，或 `all`/`music`/`wiki`。默认 `all` |
| `--limit` | 每个来源**搜索/拉取多少首**（歌曲搜索数量，按来源），默认 20 |
| `--total` | 最终歌单/结果总数上限（跨来源去重后，`0` = 不限制） |
| `--output` | 输出根目录，默认 `output`（其下按 歌手/歌名 建工作区） |
| `--prefix` | 工作区目录名（默认按歌手/歌名自动命名） |
| `--page-size` | 数量分页：每页/每文件处理多少首歌，默认 500 |
| `--workers` | 并行抓取线程数，默认 3（过大可能被平台限流） |
| `--validate` | 校验指定 JSONL 后退出 |
| `--quiet` | 不打印每步抓取进度，只输出最终摘要 |
| `--singer` | 强制虚拟歌手模式：启用百科(VCPedia/萌娘)按歌手检索歌页 |
| `--resume` | 保留参数（现由 `seen.json` 自动续抓，无需手动 resume） |
| `--songs-file` | 用现成歌单 JSONL 抓歌词（跳过发现阶段） |
| `--songs-only` | 只生成歌单文件，不抓歌词 |

`--artist` 与 `--query` 至少提供一个。给 `--artist` 时，**先拉歌单**：网易云为主（分页取更多），QQ/酷我补充，虚拟歌手（`--singer` 或内置名单）再启用 VCPedia 按歌手检索歌页；所有来源按歌曲去重、保留优先级最高的来源。

给 `--query` 时，各来源按歌名精确搜索。无论哪种方式，**每首歌都会再用萌娘/VCPedia 做一次交叉验证**（命中/缺失/不可用），结果记入状态文件。

来源优先级（**歌词来源，百科为主，避免翻唱/同曲多版本**）：VCPedia > 萌娘 > 网易云 > QQ > 酷我。百科收录的是原作/权威版本；音乐平台用于百科没有的歌（作为回退）。

**歌单排序**：被多个平台命中的歌优先（`hits` 越高越靠前），命中数相同再按来源优先级。歌单里每首会带 `hits` / `hit_sources` 字段，便于看到该歌被几个来源认可。

运行时默认打印抓取进度（来源、命中数、每首成功/失败、耗时），例如：

```text
[18:16:18] 开始抓取 → artist=周杰伦  query=-  sources=netease,qq,vcpedia  每来源上限=3
[18:16:18] [netease] 正在搜索 '周杰伦' ...
[18:16:30] [netease] (1/3) 成功  想你就写信 (Live)
[18:16:42] [netease] 完成 → 成功 3 / 失败 0
[18:17:06] 百科补充: 将用 6 个歌名查询 vcpedia ...
[18:17:13] [vcpedia] '想你就写信 (Live)' → 未找到页面
[18:17:25] 抓取结束, 写文件 → output (前缀 lyrics-prog)
[耗时]  67.3 秒
```

加 `--quiet` 只保留最终摘要，适合在脚本/后台运行时使用。

### 手动终止与断点续抓

抓取过程中随时按 **Ctrl+C** 即可**手动终止**：程序会保存已抓取的歌词与断点状态（`<prefix>.state.json`），并写出当前已完成的 `*.jsonl` / `*.errors.jsonl`。之后用 `--resume` 从断点继续，已完成的歌曲不会重复查询。

## 来源

| 来源 | 名称 | 搜索 | 歌词 | 说明 |
|---|---|---|---|---|
| `netease` | 网易云音乐 | 明文 `/api/v1/search/get` | `/api/song/lyric` | 可用 |
| `qq` | QQ音乐 | `client_search_cp` | `fcg_query_lyric_new.fcg` | 可用 |
| `kuwo` | 酷我音乐 | `search.kuwo.cn/r.s` | `mobi.kuwo.cn/mobi.s` | 尽力而为，部分网络被网关拦截(502) |
| `vcpedia` | VCPedia | MediaWiki `list=search` + **`Category:<歌手>歌曲` 分类枚举**(特化) | `prop=revisions` + `<poem>`(歌词小节) | 可用(虚拟歌手, 歌名很全) |
| `moegirl` | 萌娘百科 | MediaWiki `list=search` | `prop=revisions` + `<poem>` | API 现对匿名访问限制，通常走 `errors.jsonl` |

> VCPedia 特化：按歌手发现歌名时**优先用 `Category:<歌手>歌曲` 分类枚举**（可翻页，覆盖更全，如洛天依可列 200+ 首），分类不存在时退化为“歌名(歌手)”后缀搜索。
>
> 说明：VCPedia/萌娘百科以**歌名**命中为准（虚拟歌手/ACG 歌曲），对主流流行歌手通常搜不到；
> 这正是“辅以”百科的定位——用歌名补充。

## 输出文件

在 **`--output/<工作区>/`** 下生成（**按歌手/歌名建工作区**，不再按天分），并按**数量分页**：每页/每文件处理 `--page-size`（默认 500）首歌，命名为 `lyrics-001.jsonl`、`lyrics-002.jsonl`…。

**跨运行去重**：每个工作区有 `seen.json`（已抓歌曲登记）。再跑同一个歌手时，**自动跳过已抓过的歌**，只抓剩余的新歌并写到下一页——既不重复抓取，也因每页限量而单次耗时可控。

| 文件 | 内容 |
|---|---|
| `<prefix>.jsonl` | 歌词记录，每行一个 JSON 对象 |
| `<prefix>.errors.jsonl` | 失败记录（不混入歌词） |
| `<prefix>.songs.jsonl` | **歌单**：候选歌曲元数据（不含歌词），供 `--songs-file` 使用 |
| `<prefix>.status.json` | 抓取状态、各来源统计、交叉验证结果、更新时间 |
| `<prefix>.state.json` | 断点状态：歌单、已完成/已验证歌曲（供 `--resume`） |

歌词记录字段：`id`、`title`、`artist`、`album`、`language`、`lyrics`、`source`；
空 `album`/`source` 会省略。示例：

```jsonl
{"id":"netease:123456789","title":"示例歌曲","artist":"示例歌手","lyrics":"示例第一行\n示例第二行","album":"示例专辑","language":"zh","source":"https://example.com/song"}
```

## ID 规范

- 来源侧 ID 为纯 ASCII → `来源名:来源歌曲ID`（如 `netease:509781655`、`qq:0039MnYb0qxYhV`）。
- 否则（中文页面标题等）或无 ID → `crawler:<sha256(标准化源+歌名+歌手+专辑)前32位>`，保证跨来源唯一且稳定。
- 仅含字母/数字/`_`/`-`/`:`，长度 ≤ 128。

## 歌词清洗规则

1. 统一为 UTF-8，`\r\n`/`\r` → `\n`。
2. 删除 LRC 时间戳与 `[ti:/ar:/al:/by:/offset:]` 元信息。
3. 删除 `作词/作曲/编曲/制作人/录音/混音…` 等制作信息行。
4. 去除首尾空白、行尾多余空格；连续空行最多保留一行。
5. 不添加歌名/歌手/来源/代码围栏，不翻译、续写或修复缺失歌词。

（歌词正文、字段约束、JSON Schema 详见规范文档，见仓库内 `来源` 说明与上方字段表。）

## 导入 chatluna-lyrics-mcp

```text
lyrics.validate "D:\path\lyrics-001.jsonl"
lyrics.replace "D:\path\lyrics-001.jsonl"

lyrics.validate "D:\path\lyrics-002.jsonl"
lyrics.merge   "D:\path\lyrics-002.jsonl"
```

## 免责与说明

- 请遵循各来源的 robots/使用条款，控制抓取频率（本程序已内置有限重试与退避）。
- 酷我/萌娘百科接口可能因网络、地区或站点策略不可用，此时对应来源会记录到 `errors.jsonl` 而非中止整个任务。

## 目录结构

```text
爬虫程序/
├── lyrics_crawler/
│   ├── __init__.py
│   ├── __main__.py        # python -m lyrics_crawler
│   ├── cli.py            # 命令行与抓取编排
│   ├── models.py         # 数据模型、清洗、ID 生成
│   ├── http_client.py    # urllib 封装(重试/退避/超时)
│   ├── output.py         # JSONL/错误/状态写入 + schema 校验
│   ├── config.py        # 来源优先级、虚拟歌手名单
│   ├── registry.py       # 来源注册表
│   └── sources/
│       ├── base.py
│       ├── netease.py  qq.py  kuwo.py  vcpedia.py  moegirl.py
├── requirements.txt      # (无第三方依赖)
├── scripts/              # 交互式一键脚本(缺省参数时中文提示)
│   ├── _common.py        #   输入提示/运行工具
│   ├── menu.py           #   主菜单入口
│   ├── crawl.py          #   完整抓取
│   ├── playlist.py       #   仅歌单
│   ├── fromlist.py       #   从歌单生成
│   ├── resume.py         #   断点续传(列出所有工作区选一个)
│   ├── interrupt.py      #   断点终止
│   └── merge.py          #   合并工作区
├── menu.bat             # 主菜单(一键)
├── crawl.bat             # 完整抓取(一键)
├── playlist.bat          # 仅歌单(一键)
├── fromlist.bat          # 从歌单生成(一键)
├── resume.bat            # 断点续传(一键)
├── interrupt.bat         # 断点终止(一键)
├── merge.bat             # 合并工作区(一键)
└── README.md
```
