# 代码签名政策 Code signing policy

> 小怪工坊正在申请 SignPath Foundation 给开源项目的免费代码签名。批下来之前，安装包没有签名。
> Beastie Works is applying for SignPath Foundation's free code signing for open-source projects. Until it is approved, the installer is not signed.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## 签什么 What is signed

只签这个仓库自己的源代码，在 GitHub 自己的 Windows 机器上自动构建出来的 Windows 安装包（[`.github/workflows/release.yml`](.github/workflows/release.yml)）。随程序带的别人的程序（Magpie、Git for Windows）照它们发布时的原样带上，核对过文件指纹，不由我们签名。

Only the Windows installer built automatically from this repository's own source, on GitHub-hosted Windows runners ([`.github/workflows/release.yml`](.github/workflows/release.yml)). Third-party programs shipped with the app (Magpie, Git for Windows) are included exactly as their projects publish them, checked against their fingerprints, and are not signed by us.

## 谁负责 Team roles

| 角色 Role | 负责的事 Responsibility | 成员 Members |
| --- | --- | --- |
| 作者 Authors | 修改源代码 Modify the source code | [Yun-BaiBai](https://github.com/Yun-BaiBai) |
| 审核 Reviewers | 审核别人提交的改动 Review changes from non-members | [Yun-BaiBai](https://github.com/Yun-BaiBai) |
| 批准 Approvers | 每次签名前人工批准 Approve each signing request by hand | [Yun-BaiBai](https://github.com/Yun-BaiBai) |

所有成员的 GitHub 和 SignPath 账号都开了两步验证。每一次发版的签名都要人工批准。

All members use multi-factor authentication on GitHub and SignPath. Every release is approved by hand before it is signed.

## 隐私 Privacy

小怪工坊不收集、不上报任何使用数据，没有统计，也没有自动更新检查。

它自己会联网的只有这两种情况：

- **读 agent 名单**：从 [Agent Client Protocol 的公开名单](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 读有哪些 agent 可以装。只是下载这份公开名单，不带你的任何信息。
- **读额度**：向你自己已经登录的那几家（比如 Anthropic、OpenAI）读你账号的用量，用的是你在那个 agent 里自己的登录，结果只显示在你的电脑上。

其他联网都是你点了才发生：装 agent 或配套工具（从 npm、GitHub 或各家官方下载）、从 GitHub 导入技能、打开各家的登录页。

你让小怪干的活，是由你选的 agent 发给它们自己的公司处理的，适用各家自己的隐私政策。

Beastie Works collects and reports no usage data: no telemetry, no automatic update checks.

It goes online on its own only to:

- **Read the agent list**: the public [Agent Client Protocol registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) of agents that can be installed. Nothing about you is sent.
- **Read quotas**: the usage of your own accounts with the makers you signed in to (such as Anthropic or OpenAI), using your own sign-in in that agent; the result stays on your computer.

Everything else happens only when you ask for it: installing agents or tools (from npm, GitHub or each maker's official downloads), importing skills from GitHub, opening a maker's sign-in page.

The work you give the gremlins is sent by the agents you chose to their own makers, under each maker's privacy policy.

## 卸载 Uninstall

在 Windows 的"设置 → 应用"里找到 Beastie Works 卸载，或者运行安装目录里的 `Uninstall Beastie Works.exe`。

Uninstall Beastie Works from Windows Settings → Apps, or run `Uninstall Beastie Works.exe` in its install folder.
