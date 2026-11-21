# 实测：小怪工坊和直接用一个 agent 比 / Measured against a single agent

2026-11-21 在一台 Windows 电脑上测的。**结论先说：在小活上，小怪工坊比直接用一个 Codex 慢、花得多。第一次测约 2.2 倍；照 Orca 的做法改了拆解后重测，时间约 2 倍、花费约 1.3 倍。** 它多花的那部分，买的是"派活前先想好怎么分""另一家公司的模型审一遍""你收下前原件不动"，不是省钱或提速。

English below.

## 怎么测的

- **同一个起点：** 一个小的 Node.js 文本工具项目（3 个文件，1 个故意留的 bug），复制成两份，一份给"单个 Codex"，一份给小怪工坊。
- **同样的三句话：** 两边说的话一字不差。
  - T1 能拆开同时做的代码活：加 wordCount 和 slugify 两个互不相干的功能，各带测试。
  - T2 普通的修 bug：countLines 最后一行没换行时少算一行。
  - T3 非代码的写作活：写 150 字左右的中文简介。
- **同样的模型：** 干活都用 Codex 的 gpt-5.6-luna、低档推理。
  - 单个 Codex：`codex exec` 直接做。
  - 小怪工坊：主理小怪和干活的小怪都用这个设置，审查用 Claude Haiku（换一家审），工位 2 个，开审查，收下后自动记笔记。
- **怎么算钱：** 两边都按程序自带的同一张价格表（LiteLLM 价格）把用掉的 token 折成美元。用订阅的话实际不按这个扣钱，只是用来比较。
- **怎么算时间：** 从发话到结果能看为止。小怪工坊这边包括遇到拆解时点"照这样拆"。
- **做没做对：** 跑测试、数字数、人看结果。三件活两边都做对了。
- 每件活每边只跑了一次，数字有偶然性。

## 结果

| 活 | 单个 Codex | 小怪工坊 | 小怪工坊是单个的 |
|---|---|---|---|
| T1 能拆的两个功能 | 95 秒，$0.034 | 277 秒，$0.150 | 2.9 倍时间，4.4 倍钱 |
| T2 修 bug | 71 秒，$0.031 | 189 秒，$0.057 | 2.7 倍，1.8 倍 |
| T3 写简介 | 102 秒，$0.047 | 120 秒，$0.038 | 1.2 倍，0.8 倍 |
| **合计** | **268 秒，$0.112** | **586 秒，$0.245** | **2.2 倍，2.2 倍** |

小怪工坊的 $0.245 里：干活的小怪 $0.191，主理小怪派活和拆解 $0.025，Claude 审查 $0.030。收下后自动记笔记另外花了 $0.036（可以在笔记页关掉）。

## 看到的

- **小活上，拆开同时做不划算。** T1 被拆成两件同时做，但拆解本身用了 57 秒，两件各自从头读项目，再各审一次，比一个 Codex 一口气做完慢得多。拆开同时做，要活本身大到读项目、想做法的时间远小于干活的时间才可能划算，这次没测这种情况。
- **审查花得不多，但要排队。** Claude Haiku 审一次大约 $0.005 到 $0.01，时间主要花在排队和来回上。
- **单个 Codex 顺手多做了一件事。** 项目原来的 `npm test` 命令在这台电脑的 Node 上跑不起来，单个 Codex 在 T1 里发现并改好了；小怪工坊这边 T1 拆开的两只小怪各管各的，都没去碰，到 T2 才由那张工单的小怪改好。
- **写作活差别最小。** T3 两边时间、花费差不多。

## 改了拆解之后重测 T1

照 Orca 的做法（它教协调者"优先自己一口气做完，哪怕是长活、并行的活"，只有真需要时才另开工人）收紧了拆解：

- 主理小怪默认一件事一张工单，只有活大到要干很久、又拆得开时才开拆解。
- 你明说"可以拆"时照样开拆解，但出拆法的小怪会先看值不值得：整件活十几二十分钟能做完的，直接说"活不大，一张工单做完更快"。

同一句 T1 在新项目副本上重跑了一次（T2、T3 没变，没重跑）：

| | 单个 Codex | 小怪工坊（改前） | 小怪工坊（改后） |
|---|---|---|---|
| T1 时间 | 95 秒 | 277 秒 | 229 秒 |
| T1 花费 | $0.034 | $0.150 | $0.046 起（见下） |
| 三件合计时间 | 268 秒 | 586 秒（2.2 倍） | 538 秒（2.0 倍） |
| 三件合计花费 | $0.112 | $0.245（2.2 倍） | 约 $0.15（约 1.3 倍） |

- **这次没拆**，一张工单做完，钱降到原来的三分之一左右。
- **审查真拦下了一个错。** 小怪第一次交的 wordCount 把中文标点算成了一个英文单词（"你好，世界"算出 5，应为 4），Claude 审查打回，小怪改好、补了测试，第二次通过。T1 这次多花的时间大半在这一来一回上。
- **审查的钱这次没记上。** 查出是程序的毛病：审查给出结论后会话关得太早，那一轮的账单还没送到。已经改好（给出结论后最多再等 15 秒收账单），所以表里改后的花费少算了两次审查，按前面的价钱约 $0.01 到 $0.02。
- 仍比单个 Codex 慢一倍左右，主要因为"主理小怪先派活""另开一只小怪从头读项目""换一家审一次"这三步本身就要时间。

## 这次没测、以后该测的

- 大活：一件要干一两个小时的活，拆开同时做能不能省下时间。
- 质量：审查到底拦下了多少错。这次三件小活都没出错，审查没有机会起作用。
- 多跑几次取平均。

---

## English

Measured on one Windows computer on 2026-11-21. **In short: on small jobs Beastie Works is slower and costs more than using one Codex directly: about 2.2 times at first, about 2× the time and 1.3× the cost after splitting was tightened.** What the extra buys is a plan for how to split the work, a review by another maker's model, and your files left alone until you accept, not savings in time or money.

**How:** the same small Node.js project copied twice; the same three sentences, word for word (T1 two independent features that can be done at once, T2 a bug fix, T3 a 150-character Chinese introduction); Codex gpt-5.6-luna on low effort for the work on both sides (Beastie Works: the lead and the gremlins on that, review on Claude Haiku, two desks, notes on). Tokens are priced with the app's own price list (LiteLLM prices) on both sides; subscribers aren't actually charged that way. Time runs from the request until the result can be looked at. All three jobs came out right on both sides. One run each.

| Job | One Codex | Beastie Works | Ratio |
|---|---|---|---|
| T1 two features that split | 95 s, $0.034 | 277 s, $0.150 | 2.9× time, 4.4× cost |
| T2 bug fix | 71 s, $0.031 | 189 s, $0.057 | 2.7×, 1.8× |
| T3 short writing | 102 s, $0.047 | 120 s, $0.038 | 1.2×, 0.8× |
| **Total** | **268 s, $0.112** | **586 s, $0.245** | **2.2×, 2.2×** |

Of Beastie Works' $0.245: gremlins $0.191, the lead (dispatch and splitting) $0.025, Claude's review $0.030. Writing notes after accepting cost another $0.036 (it can be turned off).

**Seen:** splitting a small job does not pay (the split alone took 57 s, and each piece re-reads the project and is reviewed on its own); review is cheap but adds waiting; the single Codex also fixed the project's broken `npm test` script in T1, which the two split gremlins each left alone; writing differed least.

**After the first run** the lead was told to split only large jobs (following Orca's orchestration guide), and the splitter now says when a job is too small to be worth splitting. T1 was rerun: not split, 229 s and at least $0.046 (was 277 s and $0.150). Totals become 538 s (2.0×) and about $0.15 (about 1.3×). In this run the Claude review caught a real bug (Chinese punctuation counted as an English word) and the gremlin fixed it. The review's own cost was not recorded because the review session was closed before its bill arrived; that is fixed now (the reviewer waits up to 15 s after the verdict).

**Not measured yet:** large jobs where parallel work might save time, how many mistakes review catches (none of these small jobs had any), and averages over several runs.
