# 修复日志

本仓库在 `dsh-read-aloud` **1.5.4** 的基础上修复了流式自动朗读的缺陷。每个版本一个
文件，按时间顺序排列。

| 版本 | 文件 | 内容 |
|---|---|---|
| 1.5.4 | — | 上游基线，见仓库第一个提交 |
| 1.5.5 | [1.5.5.md](1.5.5.md) | 流式朗读漏句：步骤切换时游标越过新文本开头 |
| 1.5.6 | [1.5.6.md](1.5.6.md) | 重启后重读历史回复（含已读持久化与空 arm 两处修复） |
| 1.5.7 | [1.5.7.md](1.5.7.md) | 步骤切换时未读完的尾部被丢弃 |
| 1.5.8 | [1.5.8.md](1.5.8.md) | 无句末标点的步骤被整段丢弃，并补上回归测试 |
| 1.5.9 | [1.5.9.md](1.5.9.md) | 播放队列中断：单句失败终止整段、无法播放的条目卡死后续 |
| 1.5.10 | [1.5.10.md](1.5.10.md) | 表格内容被整段丢弃；已读标记早于可朗读判断，导致最后一句不再读 |

任何对 `client.js` 的改动都应先读对应的修复日志，避免把修复当成插件原生行为而误删。

## 查看改动

每个版本都有对应的 Git 标签：

```powershell
git log --oneline --decorate
git diff v1.5.4:client.js client.js           # 相对上游基线的全部改动
git diff v1.5.6:client.js v1.5.7:client.js    # 单个版本之间
git show v1.5.7 --stat
```

## 回归测试

```powershell
node test\regression.mjs
```

应输出 `37/37 通过`。测试从 `client.js` 源码中按函数名抽取真实实现运行，不复制
逻辑，因此能真实反映当前实现。

## 挂载方式

本插件以 `link:` 方式挂载到 DeepSeek Harness 的 `desktop` profile，集成点在
profile 目录，不在本仓库：

```
<DSH_HOME>\profiles\desktop\
├── package.json          # dependencies: "@local/dsh-read-aloud": "link:<本仓库绝对路径>"
├── pnpm-lock.yaml        # 记录 link 解析结果
└── node_modules/@local/dsh-read-aloud   # 指向本目录的符号链接
```

若移动本目录，需在 profile 目录重新安装并重启 Harness：

```powershell
dsh plugin --profile desktop install
```

改动 `client.js` 后必须**重启 Harness** 才会生效——插件只在启动时加载。
判断是否已加载：进程启动时间需晚于 `client.js` 的写入时间。

## 修改代码时的注意事项

- `client.js` 必须保持 **UTF-8 无 BOM**。用 PowerShell 5.1 的
  `Get-Content -Raw | Set-Content` 处理会因 GBK 往返毁掉全部中文（曾发生过，文件
  从 88KB 膨胀到 93KB，中文变成乱码）。请用编辑器或 Node 读写。
- 测试从源码中按函数名抽取真实实现运行，因此**重命名函数会导致测试报「找不到
  xxx」**。改名时请同步更新测试的 `CLOSURE` 列表。
