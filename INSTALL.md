# 安装指南

本插件是 DeepSeek Harness（下称 DSH）的 Web UI 插件，以 `link:` 方式挂载到 DSH
的 profile 上。仓库**不含语音模型**——模型体积大且授权各异，需自行下载后登记。

不装模型也能用：插件会自动回退到浏览器内置的系统语音，只是音质和可用语种受限。

---

## 一、前置条件

| 项目 | 要求 | 检查方式 |
|---|---|---|
| DeepSeek Harness | 桌面版（Electron），Web UI 可用 | 能正常打开 Harness 界面 |
| DSH profile | 通常是 `desktop` | 见下方「确认 profile」 |
| Git | 用于克隆仓库 | `git --version` |
| Node.js | 仅跑回归测试时需要 | `node --version` |

语音合成**依赖 DSH 自带的 `sherpa-onnx-node`**（语音输入功能用的就是它），插件不
额外引入这个依赖，所以不需要另外 `npm install`。

### 确认 profile

DSH 的 profile 目录通常在 `%USERPROFILE%\.dsh\profiles\<名称>`。桌面版默认使用
`desktop`，它由 Electron 应用独占管理，**不能用 `dsh --profile desktop` 直接启动**。

```powershell
dir $env:USERPROFILE\.dsh\profiles
```

后续命令以 `desktop` 为例，若你的 profile 名字不同请替换。

---

## 二、获取代码

```powershell
git clone <本仓库地址> dsh-read-aloud
cd dsh-read-aloud
```

**建议把仓库放在固定位置**，不要放在临时目录。后续 profile 里记录的是绝对路径，
移动仓库会导致插件失效（需重新执行第四步）。

---

## 三、定位 dsh 命令

DSH 桌面版自带 CLI，路径形如：

```
<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd
```

Windows 上常见于 `C:\Program Files\DeepSeek Harness\` 或 `D:\deepseek\`。若已在
`PATH` 中，直接用 `dsh` 即可；否则用完整路径。

```powershell
# 验证可用
dsh --version
```

---

## 四、挂载插件到 profile

在 **profile 目录**下执行（不是在仓库目录里）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop

# 把 <本仓库绝对路径> 换成第二步克隆出来的真实路径，注意用正斜杠或双反斜杠
dsh plugin --profile desktop add "@local/dsh-read-aloud@link:D:/path/to/dsh-read-aloud"
```

成功的话会看到类似输出：

```
dependencies:
+ @local/dsh-read-aloud 1.5.8 <- D:\path\to\dsh-read-aloud
```

这一步做了两件事：往 profile 的 `package.json` 写入一条 `link:` 依赖，并在
`node_modules/@local/` 下建立指向仓库的链接。

> **为什么用 `link:` 而不是 `npm install`**：仓库没有发布到 npm，且插件需要直接读取
> 工作区里的文件。`link:` 让 DSH 加载的就是你克隆下来的这份代码，改完重启即生效。

---

## 五、安装语音模型（可选）

不装模型也能用系统语音。想要离线神经音色才需要这一步。

### 5.1 下载模型

DSH 语音合成基于 sherpa-onnx，中文语音模型可从其官方 release 下载：

- 模型发布页：<https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models>
- 在页面中搜索 `zh_CN` 或 `Chinese` 找到中文模型

常见可用的中文模型类型：

| 类型 | 文件特征 | 说明 |
|---|---|---|
| Piper / VITS | `*.onnx` + `tokens.txt` + `lexicon.txt` | 体积小、速度快，单语（不读英文） |
| Matcha | `model-steps-*.onnx` + `vocos-*.onnx` + `espeak-ng-data/` | 中英混读，快，16 kHz |
| Kokoro | `*.onnx` + `voices.bin` + `espeak-ng-data/` | 多语言多音色，音质最好，体积大 |

下载后解压，把**整个模型目录**放到：

```
%USERPROFILE%\.dsh\read-aloud-voices\<音色id>\
```

其中 `<音色id>` 由你决定，会作为音色的内部标识（只能用英文、数字和连字符）。

### 5.2 编写 plugin.json

在上述目录里新建 `plugin.json`，格式如下。**这是唯一需要手写的文件**。

Piper / VITS 单语模型：

```json
{
  "id": "my-voice",
  "label": "我的中文男声",
  "description": "中文单语模型，完全离线",
  "language": "zh-CN",
  "license": "CC0",
  "model": {
    "file": "model.onnx",
    "tokens": "tokens.txt",
    "lexicon": "lexicon.txt"
  },
  "ruleFsts": ["date.fst", "number.fst", "phone.fst"]
}
```

字段说明：

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 是 | 音色内部标识，建议与目录名一致 |
| `label` | 否 | 设置界面显示的名称，缺省用目录名 |
| `description` | 否 | 说明文字 |
| `language` | 否 | 默认 `zh-CN` |
| `license` | 否 | 授权说明，仅用于界面展示 |
| `model.file` | 是 | 声学模型文件名 |
| `model.tokens` | 是 | tokens 文件名 |
| `model.lexicon` | 视模型 | 词典文件名，Piper 中文模型通常需要 |
| `model.kind` | 视模型 | `matcha` / `kokoro`，VITS 模型省略 |
| `model.vocoder` | Matcha 必需 | 声码器文件名 |
| `model.voices` | Kokoro 必需 | voices 文件名 |
| `ruleFsts` | 否 | 数字/日期读法规则，缺失时按字面推理 |
| `slow` | 否 | `true` 表示合成慢，界面会提示 |
| `speakers` | 否 | 多说话人模型的说话人列表 |

Matcha 模型额外写：

```json
"model": {
  "kind": "matcha",
  "file": "model-steps-3.onnx",
  "vocoder": "vocos-16khz-univ.onnx",
  "tokens": "tokens.txt",
  "lexicon": "lexicon.txt",
  "dataDir": "espeak-ng-data"
}
```

Kokoro 模型额外写：

```json
"model": {
  "kind": "kokoro",
  "file": "model.onnx",
  "voices": "voices.bin",
  "tokens": "tokens.txt",
  "dataDir": "espeak-ng-data"
}
```

### 5.3 注意事项

- **文件名必须与实际文件完全一致**，包括大小写。插件启动时会逐个校验，缺失会在
  设置界面的音色列表里给出提示。
- `plugin.json` 用 **UTF-8 无 BOM** 保存。PowerShell 的 `Set-Content` 默认会加
  BOM，虽然插件会剥掉，但建议直接用编辑器保存。
- 模型授权取决于模型包，商用前请核对模型卡。部分中文模型基于带非商用限制的数据集
  （如 BZNSYP）训练。

---

## 六、重启并验证

**插件只在 DSH 启动时加载**，改完必须重启。

重启后：

1. 打开任意会话，助手回复下方应出现**喇叭按钮**
2. 设置 → 通用 → 朗读，应能看到音色列表
3. 点喇叭试听，或打开会话标题栏的**自动朗读开关**

### 判断插件是否真的加载了

如果界面没变化，先确认 DSH 用的是新代码：

```powershell
# 文件写入时间
(Get-Item <仓库路径>\client.js).LastWriteTime

# DSH 进程启动时间
Get-CimInstance Win32_Process -Filter "Name='*Harness*'" |
  Where-Object { $_.CommandLine -match 'profiles' } |
  Select-Object ProcessId, CreationDate
```

**进程启动时间必须晚于文件写入时间**，否则说明重启没有真正生效。

---

## 七、更新

```powershell
cd <仓库路径>
git pull
# 然后重启 DSH
```

因为用的是 `link:`，不需要重新执行第四步。

---

## 八、卸载

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
dsh plugin --profile desktop remove @local/dsh-read-aloud
# 重启 DSH
```

语音模型留在 `~/.dsh/read-aloud-voices/`，不需要可自行删除。

---

## 九、常见问题

**插件装了但界面没反应**
检查 DSH 进程启动时间是否晚于文件写入时间，见第六节。另外确认 profile 名字对得上。

**音色列表是空的**
没有安装模型，或 `plugin.json` 有问题。检查目录结构：
`~/.dsh/read-aloud-voices/<id>/plugin.json`，且 `model.file` 指向的文件确实存在。

**朗读没声音，但按钮在动**
默认可能是浏览器系统语音，受系统音量与浏览器语音设置影响。装了离线模型就在设置里
显式选它。

**英文被跳过**
单语中文模型不认识英文。要么换 Matcha / Kokoro 这类多语言模型，要么依赖系统英文
音色（需系统装有英文语音包）。

**想跑回归测试**

```powershell
cd <仓库路径>
node test\regression.mjs
```

应输出 `28/28 通过`。

**改完代码不生效**
插件只在启动时加载，必须重启 DSH。
