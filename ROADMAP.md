# 路线图 Roadmap

这里写小怪工坊接下来打算做的事。**不写日期**：做好一项、测过了才发版。顺序可能变，想法欢迎在 Issue 里提。

英文在后面。

## 1.0

- 每个工位单独设置：挑小怪、起名字，配 agent、模型、推理档位、能用的技能，额度到上限按自己的备用清单换或者等；最多 8 个工位
- 跟主理小怪点名工位派活，工位忙就排队等它
- 主理小怪和审查也能点开换 agent、设额度规矩
- 主理小怪重启后接着之前的对话
- 语音输入改成在本机离线识别（SenseVoice 模型，第一次用时下载），不联网、不花钱
- 另一家公司的 agent 又把整个程序审了一遍，查出的问题都修了；Electron 升到 43

## 0.9（已发布）

- 设置补齐：同时几只小怪、应急名额、花费上限、技能文件夹、白天/夜晚/跟系统
- 圆桌会议：说"出方案"，几家 agent 各自出方案，主理小怪整理成 Plan A / Plan B 让你选，选完自动开工
- 巡查：干得太久、花得太多、可能跑偏的活会提醒你（只提醒，不替你停）
- 自带基础技能：find-skills、agent-browser、agent-desktop、agent-reach，配套工具一键装
- 语音输入：输入框旁的麦克风按钮，用 Windows 自带的语音输入
- Cursor、Kimi、Grok 在程序里点"去登录"就能登录；Antigravity 能用编辑器那份登录（要装 agy 命令行）
- 英文界面
- 任何活都能干：验证按活的种类来（代码跑测试，文字核对要求，图片音视频看格式和截图）
- 项目笔记、工序链（先手动点"下一道"）、拆解工单（只拆大活，你点头后一起做）
- 和直接用一个 agent 比的实测数字，见 [docs/benchmark.md](docs/benchmark.md)
- 整体代码审查（用另一家的 agent）和修复

## 下一步

- **Windows 代码签名**：已在申请开源项目的免费签名，批下来后装的时候不再弹"已保护你的电脑"
- 在一台真的干净电脑上从零装一遍、派一件活
- 名单上更多 agent 真派活试一遍（现在试过的：Codex、Claude、DeepSeek Harness、Antigravity）
- 工序链跑顺后，上一道收下自动开下一道
- 大活上测一次拆开同时做到底省不省时间

## 以后再看

还没定要做，有人需要再说：

- 云端听写（要 Fish Audio 或 ElevenLabs 的 Key），现在用 Windows 自带的够了
- macOS、Linux 版：程序本身大部分不挑系统，但目前只在 Windows 上测过、打过包
- 更多随程序带的技能和小怪皮肤，欢迎投稿，见 [CONTRIBUTING.md](CONTRIBUTING.md)

---

## English

What Beastie Works plans to do next. **No dates**: a release goes out once its items are done and tested. The order may change; ideas are welcome as issues.

### 1.0

- Each desk set up on its own: its gremlin and name, agent, model, reasoning level, skills, and what to do when quota runs out (a list of backups, or wait); up to 8 desks
- Name a desk when giving the Lead Gremlin a job; a busy desk gets it queued
- Change the Lead Gremlin's and review's agent and quota rule from their pages
- The Lead Gremlin carries on its conversation after a restart
- Voice input recognised on this computer (the SenseVoice model, downloaded on first use): offline and free
- Another company's agent reviewed the whole program again and every finding was fixed; Electron 43

### 0.9 (released)

- Fuller settings: how many gremlins at once, an emergency slot, a spending cap, skill folders, day / night / follow the system
- Roundtable: say "give me plans" and several agents each write one; the Lead Gremlin sorts them into Plan A / Plan B for you, and the one you pick starts right away
- Patrol: work that runs too long, costs too much, or may have drifted gets flagged to you (flagged only, never stopped for you)
- Built-in basic skills: find-skills, agent-browser, agent-desktop, agent-reach, with their tools one click away
- Voice input: a mic button next to the text boxes, using Windows' own voice typing
- Sign in to Cursor, Kimi and Grok from inside the app; Antigravity can use the editor's sign-in (with the agy CLI installed)
- English interface
- Any kind of work: verification fits the work (tests for code, checking against the request for writing, format and screenshots for images, audio and video)
- Project notes, work chains (you click "next stage" for now), and splitting tickets (large jobs only, after your OK)
- Measured against using one agent directly: [docs/benchmark.md](docs/benchmark.md)
- A whole-program code review by another maker's agent, and the fixes

### Next

- **Windows code signing**: applying for free signing for open-source projects, so installing no longer shows "Windows protected your PC"
- A from-scratch install on a really clean computer, with one real job
- Real work for more agents on the list (tried so far: Codex, Claude, DeepSeek Harness, Antigravity)
- Once work chains run smoothly, starting the next stage automatically when one is accepted
- Measuring once on a large job whether splitting it saves time

### Maybe later

Not decided; say so if you need one:

- Cloud dictation (needs a Fish Audio or ElevenLabs key); Windows' own voice typing is enough for now
- macOS and Linux builds: most of the app isn't tied to Windows, but it has only been tested and packaged there
- More bundled skills and gremlin skins; contributions welcome, see [CONTRIBUTING.md](CONTRIBUTING.md)
