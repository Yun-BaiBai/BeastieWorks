# 小怪工坊 Beastie Works

把你电脑上已经装好的 AI agent（Codex、Claude、Gemini、DeepSeek、Kimi、Copilot……）叫到一起干活。

你只跟主理的小怪A说话：它把你的话变成工单，派给干活的小怪；干完由另一家的 agent 审查一次；最后你看结果，决定收下还是打回。写程序、写小说、做视频素材整理，任何文件夹都能当项目。

- **用你自己的 agent 和账号**：每个 agent 带着它平时的插件、连接器和登录，程序不另外收费，也不往外发统计。
- **几只小怪同时干**：每张工单一只小怪、一份自己的工作副本，互不干扰；你不要的改动直接扔掉，项目不受影响。大文件（视频、音频素材）不复制，链接过去。
- **额度看得见**：读得到各家的用量。到上限时可以等它重置，也可以换个模型接着干（同家换，或经自带的 Magpie 换成别家的模型），事先设好就自动执行，随时也能手动改。
- **通用技能库**：读你电脑上共享的技能文件夹（`~/.agents/skills`），也能从 GitHub 导入；每个技能默认关着，打开了小怪才用得上，用得少的能看出来、能删。
- **没装的 agent 一键装**：程序自带 npm 和 git，朋友的电脑什么开发工具都不用先装。登录在各 agent 自己的网页或终端里完成。

## 下载安装（Windows）

1. 到 [Releases](https://github.com/Yun-BaiBai/BeastieWorks/releases) 下载最新的 `Beastie-Works-x.y.z-win-x64-setup.exe`。
2. 双击安装。安装包没有数字签名，Windows 可能提示"已保护你的电脑"：点"更多信息" → "仍要运行"。
3. 第一次打开会让你选项目文件夹，并给"小怪A / 干活的小怪 / 审查"各挑一个本机的 agent。

目前只有 Windows 版。

## 常见问题

- **要先装哪些 agent？** 至少一个。没装的可以在程序的"agent 名单"里一键装；Claude 也在那里装（程序不预装它）。
- **审查为什么要换一家？** 换一家公司的模型来审，才有新的眼光；同一家自己审自己，等于把原方案重读一遍。
- **会动我的项目吗？** 小怪在自己的副本里干，只有你点"收下"，改动才会放进项目；不会替你提交 git。

## 开发

```
npm install
npm run build
npm run dev
```

测试用程序自带的 Electron 跑（`ELECTRON_RUN_AS_NODE=1`）：

```
electron --test test/native/v8-workbench.test.cjs
```

打 Windows 安装包：`npm run dist:win`（需要设置 `BEASTIE_MAGPIE_EXE` 指向 Magpie v0.1.1336 程序，`BEASTIE_MINGIT_ZIP` 指向 MinGit 2.56.1 压缩包，两者都会核对文件指纹）。

## 来源与许可

MIT 许可，见 [LICENSE](LICENSE)。

小怪工坊最早从 [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) 的源代码起步，之后改写成了自己的程序；参考、照搬了 [OpenMausBot](https://github.com/milind-soni/OpenMausBot)、[Orca](https://github.com/stablyai/orca)、[T3 Code](https://github.com/pingdotgg/t3code) 的部分做法和代码；随程序带有 [Magpie](https://github.com/yetone/magpie) 和 [Git for Windows](https://github.com/git-for-windows/git)。各自的许可和版权声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

---

## English

Beastie Works brings the AI agents already installed on your computer (Codex, Claude, Gemini, DeepSeek, Kimi, Copilot…) together. You talk to one lead; it turns what you say into tickets and hands each to a worker agent with its own copy of the project; another maker's model reviews the result once; you accept or send it back. Each agent keeps its own plugins, connectors and sign-in. Quota is visible per agent; when it runs out you can wait or switch models (including another maker's, through the bundled Magpie), set in advance or by hand. Skills come from the folder your agents share (`~/.agents/skills`) or from GitHub. npm and git ship with the app, so a computer needs no developer tools first.

Download the Windows installer from [Releases](https://github.com/Yun-BaiBai/BeastieWorks/releases). It is not code-signed yet: on "Windows protected your PC", choose "More info" → "Run anyway". The interface is in Chinese for now.

MIT licensed. Third-party notices: [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
