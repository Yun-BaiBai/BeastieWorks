# 小怪工坊 Beastie Works

把你电脑上已经装好的 AI agent（Codex、Claude、Gemini、DeepSeek、Kimi、Copilot……）叫到一起干活。

你只跟主理的主理小怪说话：它把你的话变成工单，派给干活的小怪；干完由另一家的 agent 审查一次；最后你看结果，决定收下还是打回。写程序、写小说、做视频素材整理，任何文件夹都能当项目。

**English below.** 界面有中文和英文两种，在"设置 → 界面语言"里换。

![调度台：中间是主理的主理小怪，两边是工位，右下是等你看的活，底下是对讲栏](docs/screenshots/board-zh.png)

- **用你自己的 agent 和账号**：每个 agent 带着它平时的插件、连接器和登录，程序不另外收费，也不往外发统计。Cursor、Kimi、Grok、Codex、Claude 等能在程序里直接点"去登录"。
- **几只小怪同时干**：每张工单一只小怪、一份自己的工作副本，互不干扰；你不要的改动直接扔掉，项目不受影响。大文件（视频、音频素材）不复制，链接过去。
- **换一家来审**：做完的活由另一家公司的 agent 对照你的原话、改动和验证结果审一次，过了才交给你。
- **圆桌会议**：说"出方案"，几家 agent 各自出一个方案，互相看不到；主理小怪整理成 Plan A / Plan B 让你选，选完自动开工。
- **巡查**：干得太久、花得太多、可能跑偏了的活，会在对讲栏提醒你。只提醒，停不停你定。
- **额度看得见**：读得到各家的用量。到上限时可以等它重置，也可以换个模型接着干（同家换，或经自带的 Magpie 换成别家的模型），事先设好就自动执行，随时也能手动改。
- **通用技能库**：随程序带几个基础技能（find-skills、agent-browser、agent-desktop、agent-reach），也读你电脑上共享的技能文件夹（`~/.agents/skills`），还能从 GitHub 导入；用得少的能看出来、能删。
- **没装的 agent 一键装**：程序自带 npm 和 git，朋友的电脑什么开发工具都不用先装。
- **说话输入**：输入框旁边的麦克风按钮，用 Windows 自带的语音输入，免费、不用 Key。

## 下载安装（Windows）

1. 到 [Releases](https://github.com/Yun-BaiBai/BeastieWorks/releases) 下载最新的 `Beastie-Works-x.y.z-win-x64-setup.exe`。
2. 双击安装。安装包还没有数字签名，Windows 可能提示"已保护你的电脑"：点"更多信息" → "仍要运行"。
3. 第一次打开会让你选项目文件夹，并给"主理小怪 / 干活的小怪 / 审查"各挑一个本机的 agent。

## 已知限制

- **只有 Windows 版**，也只在 Windows 上测过。
- **安装包没有签名**，安装时 Windows 会提示一次（申请签名在做，见路线图）。
- **真正派过活的 agent** 目前是 Codex、Claude、DeepSeek Harness、Antigravity；名单上其他 agent 能装、能认出登录没有，但还没真的派活跑过。Cursor、Kimi、Grok 在程序里登录的做法照着它们官方程序的输出写好了，还没用真账号登过一遍。
- **额度读数**：Claude、Codex 是直接读的；其他家经自带的 Magpie 读，有的读不到。有的 agent 不报美元，花费是按官方价格估的，订阅用户实际不按这个扣钱。
- **经 Magpie 换别家的模型**，用的是你电脑上已经登录的订阅账号。部分服务的条款可能不允许这样用，请自己判断；只用自己名下的账号，不要多人共用。
- **语音输入**只接了 Windows 自带的（Win+H）。
- **给 agent 的说明是中文写的**。用英文界面时，小怪会用英文跟你说话。
- **不省钱也不提速（小活上）**：实测三件小活，小怪工坊比直接用一个 Codex 慢、花得多（改了拆解后时间约 2 倍、花费约 1.3 倍）；多出来的是先想好怎么分、换一家审、收下前原件不动。测法和数字见 [docs/benchmark.md](docs/benchmark.md)。

## 常见问题

- **要先装哪些 agent？** 至少一个。没装的可以在程序的"agent 名单"里一键装；Claude 也在那里装（程序不预装它）。
- **审查为什么要换一家？** 换一家公司的模型来审，才有新的眼光；同一家自己审自己，等于把原方案重读一遍。
- **会动我的项目吗？** 小怪在自己的副本里干，只有你点"收下"，改动才会放进项目；不会替你提交 git。

## 接下来做什么、怎么参与

- 路线图：[ROADMAP.md](ROADMAP.md)
- 参与贡献、本地开发、提 PR：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 代码签名政策和隐私说明（Code signing policy）：[CODE_SIGNING.md](CODE_SIGNING.md)

## 开发

```
npm install
npm run build
npm run dev
```

测试用程序自带的 Electron 跑（`ELECTRON_RUN_AS_NODE=1`），不会调用任何模型：

```
electron --test test/native/v8-workbench.test.cjs
```

打 Windows 安装包：`npm run dist:win`（需要设置 `BEASTIE_MAGPIE_EXE` 指向 Magpie v0.1.1336 程序，`BEASTIE_MINGIT_ZIP` 指向 MinGit 2.56.1 压缩包，两者都会核对文件指纹）。

## 来源与许可

MIT 许可，见 [LICENSE](LICENSE)。

小怪工坊最早从 [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) 的源代码起步，之后改写成了自己的程序；参考、照搬了 [OpenMausBot](https://github.com/milind-soni/OpenMausBot)、[Orca](https://github.com/stablyai/orca)、[T3 Code](https://github.com/pingdotgg/t3code) 的部分做法和代码；随程序带有 [Magpie](https://github.com/yetone/magpie)、[Git for Windows](https://github.com/git-for-windows/git) 和几个开源技能。各自的许可和版权声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

---

## English

Beastie Works brings the AI agents already installed on your computer (Codex, Claude, Gemini, DeepSeek, Kimi, Copilot…) together to work for you.

You only talk to the Lead Gremlin. It turns what you say into tickets and hands each to a worker gremlin; when a job is done, an agent from another maker reviews it once; then you look at the result and accept it or send it back. Code, a novel, sorting video footage: any folder can be a project.

The interface comes in Chinese and English; switch under Settings → Language.

![The agent list in English: installed agents, whether each is signed in, and a chat box to try one](docs/screenshots/agents-en.png)

- **Your own agents and accounts**: each agent keeps its usual plugins, connectors and sign-in. The app charges nothing and sends no telemetry. Cursor, Kimi, Grok, Codex, Claude and others can be signed in from inside the app.
- **Several gremlins at once**: one gremlin and one private working copy per ticket, so they don't get in each other's way; changes you don't want are thrown away and the project is untouched. Big files (video, audio) are linked, not copied.
- **A second maker reviews**: finished work is checked by another company's agent against your words, the changes and the verification, and only reaches you once it passes.
- **Roundtable**: say "give me plans" and several agents each write one without seeing the others'; the Lead Gremlin sorts them into Plan A / Plan B, and the one you pick starts right away.
- **Patrol**: work that runs too long, costs too much or may have drifted is flagged in the talk bar. Flagged only; you decide whether to stop it.
- **Quota you can see**: usage is read per agent. When it runs out you can wait for the reset or switch models (same maker, or another maker's through the bundled Magpie), set in advance or by hand.
- **One skill library**: a few basic skills ship with the app (find-skills, agent-browser, agent-desktop, agent-reach); it also reads the skill folder your agents share (`~/.agents/skills`) and imports from GitHub. Skills nobody uses are easy to spot and remove.
- **One-click install for missing agents**: npm and git ship with the app, so a computer needs no developer tools first.
- **Voice input**: a mic button next to the text boxes uses Windows' own voice typing, free and keyless.

### Install (Windows)

1. Download the latest `Beastie-Works-x.y.z-win-x64-setup.exe` from [Releases](https://github.com/Yun-BaiBai/BeastieWorks/releases).
2. Run it. The installer isn't code-signed yet, so Windows may say "Windows protected your PC": choose "More info" → "Run anyway".
3. On first start, pick a project folder and an agent on this computer for each role: the lead, the worker gremlin, and review.

### Known limitations

- **Windows only**, and only tested on Windows.
- **The installer isn't signed**, so Windows warns once when installing (signing is in progress; see the roadmap).
- **Agents that have really done work** so far: Codex, Claude, DeepSeek Harness and Antigravity. The other agents on the list install and report whether they're signed in, but haven't been given real work yet. Signing in to Cursor, Kimi and Grok from inside the app follows what their official programs print, but hasn't been tried with real accounts yet.
- **Quota readings**: Claude and Codex are read directly; others go through the bundled Magpie, and some can't be read. Some agents don't report dollars, so their cost is estimated from official prices; subscribers aren't actually charged that way.
- **Switching to another maker's model through Magpie** uses the subscription accounts signed in on your computer. Some services' terms may not allow this; judge for yourself, use only accounts in your own name, and don't share them.
- **Voice input** only uses Windows' own voice typing (Win+H).
- **The instructions given to agents are written in Chinese.** With the English interface, the gremlins talk to you in English.
- **It doesn't save money or time (on small jobs)**: on three measured small jobs Beastie Works was slower and cost more than one Codex used directly (after tightening splitting: about 2× the time, 1.3× the cost); the extra buys a plan for splitting, a review by another maker, and your files untouched until you accept. Method and numbers: [docs/benchmark.md](docs/benchmark.md).

### FAQ

- **Which agents do I need first?** At least one. Missing ones install with one click from the app's agent list; Claude installs there too (the app doesn't bundle it).
- **Why does another maker review?** A different company's model brings fresh eyes; a maker reviewing itself just rereads its own plan.
- **Will it touch my project?** Gremlins work in their own copies; changes go into your project only when you click Accept. It never commits to git for you.

### What's next, and taking part

- Roadmap: [ROADMAP.md](ROADMAP.md)
- Contributing, local development, pull requests: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security problems: [SECURITY.md](SECURITY.md)
- Code signing policy and privacy: [CODE_SIGNING.md](CODE_SIGNING.md)

### Development

```
npm install
npm run build
npm run dev
```

Tests run under the app's own Electron (`ELECTRON_RUN_AS_NODE=1`) and never call a model:

```
electron --test test/native/v8-workbench.test.cjs
```

Windows installer: `npm run dist:win` (set `BEASTIE_MAGPIE_EXE` to the Magpie v0.1.1336 program and `BEASTIE_MINGIT_ZIP` to the MinGit 2.56.1 zip; both are checked against their fingerprints).

### Credits and license

MIT licensed; see [LICENSE](LICENSE).

Beastie Works started from the source code of [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) and has since been rewritten as its own program. It ports ideas and code from [OpenMausBot](https://github.com/milind-soni/OpenMausBot), [Orca](https://github.com/stablyai/orca) and [T3 Code](https://github.com/pingdotgg/t3code), and ships with [Magpie](https://github.com/yetone/magpie), [Git for Windows](https://github.com/git-for-windows/git) and a few open-source skills. Their licenses and notices are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
