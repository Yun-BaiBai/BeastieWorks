# 参与贡献 Contributing

欢迎一起把小怪工坊做好。下面先讲中文，英文在后面。

## 先看这里

- **报 bug**：开一个 Issue，选"Bug 报告"，写清楚怎么重现。
- **想要新功能**：先开 Issue 选"想要的功能"，说清楚你想解决什么问题。大一点的改动先在 Issue 里聊好再动手，免得白做。
- **安全问题**不要开公开 Issue，照 [SECURITY.md](SECURITY.md) 私下报告。
- 计划做哪些事，看 [ROADMAP.md](ROADMAP.md)。

## 适合第一次上手的活

这些活不碰核心的派活、审查流程，改错了影响也小：

- **技能**：给 `resources/skills` 加一个随程序带的技能（要带它的许可文件，并补进 `THIRD_PARTY_NOTICES.txt`），或者改进现有技能的说明。
- **小怪皮肤**：小怪的图在 `src/renderer/src/projects/office/assets/gremlins3`，图的清单在 `src/renderer/src/projects/office/gremlinArt.ts`，名字和姿势在 `src/renderer/src/v8/gremlins.ts`。新皮肤要是你自己画的，或者许可允许用。
- **主题和配色**：白天、夜晚两套颜色都在样式里的颜色变量上，改的时候两套都看一眼。
- **翻译**：英文在 `src/shared/i18n/en.json`，中文原句是钥匙。哪句英文读着别扭，直接改右边那句。
- **文档**：README、这份说明、各页面上的提示文字，读着不顺的地方。

## 在自己电脑上跑起来

要 Node.js 20 或更新，以及 npm。目前只有 Windows 上完整测过。

```
npm install
npm run build
npm run dev
```

检查类型：`npm run typecheck`。

测试用程序自带的 Electron 跑（不用另装 Node 版本，也不会调用任何模型）：

```
set ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe --test test/native/v8-workbench.test.cjs
```

想跑全部测试，把 `test` 下所有 `*.test.cjs` 都传给 `--test`。测试里的 agent 都是假的（`test/fixtures` 里的替身程序），不花任何额度；新写的测试也请这样做。

## 写代码的规矩

- **界面上的字都过 `tr()`**：写 `tr('中文原句')`，再在 `src/shared/i18n/en.json` 里加上英文。会变的部分写成 `{0}`、`{1}`。漏了英文的话，`v8-i18n` 测试会报出来。
- **给 agent 看的提示词**（`src/main/v8/prompts.ts` 等）不过 `tr()`，保持一份。
- **能照搬就照搬**：别的开源项目已经做好的，照它的做法搬过来，在文件开头写明出处，并把许可补进 `THIRD_PARTY_NOTICES.txt`。只搬许可允许的（MIT、Apache 2.0 这类）。
- **改动小而集中**：一个 PR 只做一件事。
- **说人话**：界面上的提示写成普通人看得懂的话，不堆术语。

## 提 PR 的流程

1. Fork 这个仓库，从 `main` 开一个新分支。
2. 改完跑 `npm run typecheck` 和相关测试，都要过。
3. 改了界面的，附上改之前、改之后的截图（白天、夜晚都看一眼）。
4. 提 PR，照模板填：改了什么、为什么、怎么验证的、可能弄坏什么。
5. 关联对应的 Issue（写 `Fixes #编号`）。

用了 AI 帮忙写的，在 PR 里说一声用了哪个，这没关系，但你要自己看过、跑过。

---

## English

Thanks for helping make Beastie Works better.

### Start here

- **Bugs**: open an issue with the "Bug report" form and say how to reproduce it.
- **Feature ideas**: open an issue with the "Feature request" form and describe the problem you want solved. Talk bigger changes through in the issue before writing code.
- **Security problems**: don't open a public issue; report privately as [SECURITY.md](SECURITY.md) says.
- What's planned: [ROADMAP.md](ROADMAP.md).

### Good first contributions

These stay away from the core flow (dispatch and review), so a mistake does little harm:

- **Skills**: add a skill that ships with the app under `resources/skills` (with its license file, and an entry in `THIRD_PARTY_NOTICES.txt`), or improve an existing one's description.
- **Gremlin skins**: the art is in `src/renderer/src/projects/office/assets/gremlins3`, listed in `src/renderer/src/projects/office/gremlinArt.ts`; names and poses are in `src/renderer/src/v8/gremlins.ts`. New art must be your own or licensed for this use.
- **Themes and colors**: day and night are both color variables in the styles; check both when you change one.
- **Translation**: English is in `src/shared/i18n/en.json`, keyed by the Chinese source line. If an English line reads badly, fix the right-hand side.
- **Docs**: the README, this guide, and the hints on each page.

### Running it locally

Node.js 20 or newer, and npm. Only Windows is fully tested for now.

```
npm install
npm run build
npm run dev
```

Type check: `npm run typecheck`.

Tests run under the app's own Electron (no other Node version needed, and no model is ever called):

```
set ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe --test test/native/v8-workbench.test.cjs
```

To run everything, pass every `*.test.cjs` under `test` to `--test`. The agents in the tests are stand-ins (`test/fixtures`) and spend no quota; please keep new tests that way.

### Rules for code

- **Every word on screen goes through `tr()`**: write `tr('中文原句')` and add the English to `src/shared/i18n/en.json`, with `{0}`, `{1}` for the parts that change. The `v8-i18n` test reports a missing line.
- **Instructions for agents** (`src/main/v8/prompts.ts` and the like) don't go through `tr()`.
- **Reuse before writing**: when another open-source project already does it, port its way, name the source at the top of the file, and add its license to `THIRD_PARTY_NOTICES.txt`. Only permissive licenses (MIT, Apache 2.0 and similar).
- **Small, focused changes**: one thing per PR.
- **Plain words**: messages on screen should read like normal speech, not jargon.

### Pull requests

1. Fork the repo and branch from `main`.
2. Run `npm run typecheck` and the relevant tests; both must pass.
3. For UI changes, attach before and after screenshots (check day and night).
4. Open the PR and fill in the template: what changed, why, how you checked it, what could break.
5. Link the issue (`Fixes #number`).

If an AI helped write it, say which in the PR. That's fine, as long as you have read and run it yourself.
