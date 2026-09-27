# 在这个仓库里干活

## 常驻纪律（每次改动都要做）

1. **fmt** —— `pnpm fmt`。提交前跑，别让格式化混进功能 diff。
2. **check** —— `pnpm check`（`tsc --noEmit`）。类型不过就别提交。
3. **查 O(n²)** —— 见下面「性能纪律」。每次碰 codegen 或框架都要过一遍。
4. **e2e** —— `pnpm e2e` 必须全绿。
5. **commit** —— 一次改动一个 commit，信息说清「改了什么、为什么」。

## 用哪个 node 跑（踩过一次，很惨）

**e2e 是直接用 node 跑 `.ts` 的**（node v24 的 strip-only 模式：只擦类型，不生成代码）。
所以有两件事必须记住：

1. **只写"可擦除"的 TS 语法。** `enum` / `namespace` / **参数属性**
   （`constructor(private x: T)`）这些"要生成代码"的语法，
   node 会直接抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
   `tsconfig.json` 里的 **`erasableSyntaxOnly: true`** 就是拦这个的 —— 别关掉它。
2. **验证要用真 node。** 这台机器上 `node` 可能是 **Bun 的 shim**
   （`/private/tmp/bun-node-*/node`），而 Bun **容忍**上面那些语法。
   于是本机一路绿灯、`pnpm e2e:tlispi` 在真 node 下直接起不来 —— 那次就是这么发生的。

`pnpm <script>` 走的是 PATH 里的 `node`（真 node），所以**门禁要按 pnpm 跑一遍**：

```bash
pnpm check && pnpm fmt:check && pnpm e2e && pnpm perf
```

（`pnpm perf` 里带了 `--expose-gc` —— 没有它，harness 的 GC 控制是个空操作，
比值会随机越线。见下面「O(n²) 审计清单」最后那一段。）

## 生成物：只有一样，而且提交进仓库（t33/t34）

    pnpm gen         # → e2e/__out__/<管线名>.pipeline.js（还有一份同名 .d.ts 接口）
    pnpm gen:check   # 重跑 gen + git diff --exit-code

产物**就是**在跑的那份代码：一个文件、一个 entry、自己 import pass 模块取 handler
（单一真相，不抄 pass 逻辑），导出 `run` / `runSteps` / `runPrefix` / `steps`。
运行期一律走 `e2e/linked.ts`，不再有 `new Function`（子进程里把 `Function` 打桩数过：0）。

- **一份管线一个文件**，文件名词干 = 管线名（`pipeline("main", …)` → `main.pipeline.js`）。
  entry 可以有 N 个，别把"只有一条"写进结构里。
- **别改成 `.ts`**：它是真文件、由 node 直接跑（`.js` 里 import `.ts` 靠 strip-only）。
  想要类型是另一件事 —— `.d.ts` 只描述**接口**，实现是纯 JS，各归各位。
- 旧的单 pass / 单组转储（`__out__/gen/*.gen.js`）**已删掉**：留两套人就分不清哪份在跑。
- 生成物目录别再整个 `rm -rf`：`gen.ts` 只清自己的 `gen/`，`run.ts` 只清自己那批
  `NN-*.json` 转储。曾经 `run.ts` 把刚生成的产物一起删了。

**过期检查有两处，都要**：`pnpm gen:check`（改 diff）和 e2e 里一条**只读**的逐字节比
（`linkPipeline(p).source` vs 盘上那份）。只有前者不够 —— 它是独立脚本，跑 e2e 不会发现。

什么改动需要重跑：语言定义（字段布局决定 walker 源码）、管线结构/名字/from-to、融合分组、
生成器自己。**不需要**：pass handler 的**函数体** —— 产物不抄它，是运行期
`rulesOf(i)` 从 `pipeline.ts` 读的。

## `Step.loop.setup`：手搭的 step 在 `run` 里还有"每-run 准备"（踩过，静默算错）

链接产物按 `Step.loop` 自己重建那一圈循环，**绕过 `run` 直接调 walker**。于是 `run` 里
除"跑循环"之外的每-run 动作全都不会发生，而且**不报错**：

- `rewrite` 重置计数器 + 按输入节点数算步数预算（不重置 → 计数器跨 round 累计，小树被
  判成"改了 1000 步在打转"）；
- `global-const` 按输入重算全局环境 `gEnv`（不重算 → 留着上一次的模块级状态，静默不折常量）。

所以每-run 准备做成显式钩子 `Step.loop.setup(input)` —— `run` 和产物**都调它**。

**当时 e2e 的等价表是绿的**：上一条 in-process 路径把 `gEnv` 留在了模块里，产物"蒙对"了。
教训 —— **模块级状态的残留会让等价断言失去意义**。新加 loop-step 时的验法：把产物里那行
`setup` 去掉，等价表**必须**变红；不变红就说明这条断言没在保护什么。

## 命令

```bash
pnpm check        # tsc --noEmit，按 tsconfig 的 include 走
pnpm fmt          # prettier 写回
pnpm fmt:check    # prettier 只检查
pnpm e2e           # 跑整条管线 + 落中间结果 + 断言（含产物过期检查）
pnpm perf          # 对数斜率拟合（n/2n/4n/8n），抓超线性
pnpm e2e:tlispi    # 交互式 REPL（也支持 -e 和管道）
pnpm gen           # 生成链接产物（提交进仓库）
pnpm gen:check     # 产物过期检查（改了东西忘了重跑 → 红）
pnpm mutate        # 变异测试：把每门 pass 改坏，看测试会不会红（审计，不是门禁）
```

这台机器上 `node` 是 Bun 的 shim；真 node 是 v24（直接跑 `.ts`，不用 flag）。

## O(n²) 审计清单（t22）

范围 = **codegen 生成的代码 + 框架自身 + 融合后的管线 + CFG 那几层**。
下表是逐处过出来的结论。位置写**文件 + 函数名**，不写行号 —— 行号会烂掉。

豁免的三类（写清楚为什么在豁免范围内）：① 单个函数/局部作用域内，n 有界；
② CFG 局部，只在自己的块内；③ 可并行 —— 纯 map，没有跨元素的顺序依赖。

| 位置                                                      | 结论                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/codegen.ts` — `emitFusedGroupRecSrc` 的浅做          | 每个非终结符一趟，子节点已经是终态 → O(节点数)                                                                                  |
| `src/codegen.ts` — `finish` / `stampFresh`                | **只走新造的节点**（已经带 `__lang__` 的子树立刻返回）。写成"每节点走一遍子树"就是 O(n²)，注释里钉着                            |
| `src/codegen.ts` — identity 路径的 `sameList`             | 每个列表字段 O(该字段长度) → 总代价 O(节点数的字段和)，线性                                                                     |
| `e2e/rewrite.ts` — `flatten`                              | 每个 `+`/`*` 节点展平一次自己的链；还有 O(k) 快路径（已是正规形就不展开也不深扫）                                               |
| `e2e/passes/algebraic-simplify.L6.pass.ts` — AC 规则      | 同上；豁免③（快路径只在自己这层看）                                                                                             |
| `e2e/passes/uncover-free.L6->L7.pass.ts`                  | 帧栈 + `WeakMap` 记忆化，代价正比于**输出**（t25/t26 还过的债）                                                                 |
| `e2e/passes/dce.L7.pass.ts`                               | 可变活跃绑定表 + 引用直接标到最内层绑定。**代价是 O(节点数 × 变量数)** —— 那是位向量数据流的标准代价，不是漏了；perf 里单独量着 |
| `e2e/cfg-passes.ts` — `liveness` 的 `join`/`eq`           | 同上：活集是名字集合，O(块数 × 变量数)，固定变量数下跟块数成正比。perf 里量着（×4.72）                                          |
| `e2e/dataflow.ts` — worklist                              | **`queue.shift()` 曾是 O(数组长度)** → n 个块 O(n²)。改成游标 + 定期丢掉前缀（均摊 O(1)）。这正是这次审计抓出来的真问题         |
| `e2e/cfg-passes.ts` — `threadJumps` 的 `resolve`          | 每条跳转沿链走一遍就是 O(n²)。加了记忆化（每条链只走一次）→ O(块数)                                                             |
| `e2e/cfg-passes.ts` — `orderBlocks` / `removeUnreachable` | BFS / DFS 各一遍 → O(块数 + 边数)                                                                                               |
| `e2e/lower-cfg.ts` — `lower`                              | 每个表达式节点进一次、出一次；`mkBlock`/`assign` 都是 O(1) 追加                                                                 |
| `e2e/lattice.ts` — `join`                                 | 常数大小                                                                                                                        |
| `e2e/fixpoint.ts` / `e2e/rewrite.ts` 的不动点判定         | **一次 `===`**，不做全量深比较（t13 验收④）                                                                                     |
| `e2e/run.ts` / `e2e/tlispi.ts` 的渲染                     | 只遍历一次；`pretty`/`dump` 都是线性                                                                                            |

### 量的时候有两个坑，踩过

1. **夹具不能建在计时里。** `best()` 会把同一个 n 跑 5 遍 —— 要是每遍都重新造一遍大程序，
   计时里量到的是"造 + 扔一堆大对象"的 GC。实测那个比值会飘到 5.5（看着像超线性），
   而分开量建图（×4.35）和分析（×3.75）都清清楚楚是线性的。
   **benchmark 自己引入的平方/GC 是 benchmark 的错。**
2. **每一趟计时之前先收一次垃圾。** 在不受控的堆上量墙钟时间，分不清"算法超线性"和
   "GC 变贵" —— 后者跟输入大小无关、却跟"跑到了第几个用例"有关。`best()` 现在每趟
   之前调一次 `collect()`（node 的 `gc()` / Bun 的 `Bun.gc(true)`）。

3. **比"比值"更稳的统计量是 log-log 斜率。** 第一版用"n 和 4n 的耗时比值 < 5"判定，
   两个点直接进噪声 —— 同一个 commit 在同一个 runtime 上比值在 4.3~5.5 之间抖，
   于是"超线性"名单每次跑都不一样（而算法一个字没改）。**一个会抖的门禁比没有门禁更糟：
   人会开始忽略它。** 现在在 `n/2n/4n/8n` 四个规模上拟合斜率（线性 = 1.00、平方 = 2.00，
   > 1.25 算超线性）：斜率是**形状**，全局性的"这次跑得慢一点"会同时抬高所有点、不改变斜率。
   > 实测换完之后 5 次连跑（两个 runtime）全绿。

另有一条纪律：**"样本太小"要当回事**。绝对时间不到 20ms 的比值全是噪声，`perf` 会自己标出来
（不带"不可信"的才算数）。踩过两次：一条用例用了嵌套 `let` 让 n 长不大、一条用例名字写着
"活跃性"实际量的却是别的函数 —— 两条都以"线性"的样子绿着，其实什么都没测。

## 类型系统的坑：TS2589（t24，已修）

**症状**

| 写法                                                   | 结果                                   |
| ------------------------------------------------------ | -------------------------------------- |
| `Program` 上挂规则 + 该 pass 有 `sig` + **不写返回注解** | TS2589（类型实例化过深）                |
| 同上但写 `(n): typeof n =>`（最自然的注解）              | TS2322，报错里还漏出泛型 `F`           |
| 同上、返回类型写错（少字段 / 错 tag）                    | TS2719「两个同名类型不相关」or 巨大的 dump |

**修法**：`pass()` 的 `rules` 参数上那一句 `NoInfer<Rules<F, O, Ctx>>`（`src/pass.ts`）。
`Pass` 接口那处不是推断点，不需要；只挡**返回位置**（`Ret<NoInfer<O>, …>`）不够，实测会误杀正例。

**原因 —— 这一节以前记错了，别再按旧记录去查那条 `MergeRules<…>` 链**

跟"语言是六七层 `derive` 叠出来的"、跟那条长链**无关**。实测（变体脚本，0/1/2/3/6 层各来一遍）：

    0 层（纯 language() 字面量 Lsrc，没有 derive）  ✗ TS2589
    1 / 2 / 3 层                                     ✗ TS2589
    真 L6（六层）                                     ✗ TS2589

真正的原因：**没有返回注解时，TS 会去 handler 的返回位置反推输出语言**，而那个位置是
`Ret<O, NT, Ctx>` = `[NodeOf<O, NT>, …]` —— `NodeOf` 是个**映射类型**，反推映射类型就爆。
`NoInfer` 让 TS 只从 `from` / `to` / `sig` 定类型参数（本来也只该从这三处定，它们都是显式
写出来的），问题消失。**检查一点没少**：`e2e/type-checks.ts` 里 6 条负例照样抓。

**注解现在可选，但建议写** —— 只影响报错信息，差一个量级：

    有注解  TS2322: Type '"Var"' is not assignable to type '"Prog"'.
            TS2739: Type '{ type: "Prog"; }' is missing the following properties …
    无注解  TS2719: … Two different types with this name exist, but they are unrelated.

差别在 TS 比的是什么：无注解时它拿两个**各自实例化**的 `Rules<…>` 去比，而那份类型里嵌着
语言声明的完整形状，于是"不认识自己"；有注解就退化成比节点本身。

**这个坑当初欠下的债（都已还）**：`global-const` / `global-dce` 因此不是普通 `pass()`，
而是手搭 Step（`opaque` / `rebuild` / 后来的 `loop.setup`）。修掉之后两条都变回普通的
`pass()`，而且 `global-const` 顺带修掉一个**真错** —— 它的全局环境现在**每轮重算**，
以前是每次 `run` 算一次、后面几轮用的是第一轮的环境。
`opaque` 现在只剩两个**循环包装器**（`rewrite` / `fixpoint`）在用，那是有道理的：循环的
逻辑就是那个循环，不在规则里。

**还剩下的缺口（`rec` 只收单个节点）**：`rec(某个数组字段)` → TS2741 `Property 'type' is missing`。
修掉 TS2589 之后**依然如此**（实测），所以它不是同一个问题。现在的写法是手动 `.map`：

    const defs = n.defs.map((d) => rec(d, genv) as [typeof d, Env]);

真要收数组得给一个**单独的入口**（不是给 `rec` 加重载 —— 试过，见下），那是一次 API 决定。

**留着的记录：试过但没走通的（别重复试）**

- **幽灵字段 `__nts__`**：当年为了绕开上面那个坑试的，方向本来就错。附带发现：做成必选
  会让 `eval.ts` 里 `Nonterminals<L7>` 炸出 TS2589 + `any` 泄漏；做成可选在
  `F extends LangDecl` 的泛型上下文里匹配不上，等于没做。
- **给 `rec` 加数组重载**：节点实参那条没事，数组那条一律 TS2589。判别实验：把重载的返回
  类型换成 `unknown[]`（浅到底）也照样报 —— 所以问题在**重载匹配**（TS 先拿节点那条去套
  数组实参，硬推 `P`），不在返回类型。数组那条排前面又会让节点实参被推成 `never[]`。
- **在类型上摊平 `derive`**：曾经以为是正解。**不必做** —— 那条链不是病因。剩下的唯一理由
  是报错信息好看（类型 dump 里会带出 `MergeRules<MergeRules<…>>`），而那是 TS 显示的问题。

**这类坑怎么查（比读类型代码有效）**：搭个变体脚本 —— 把同一个模式写成 N 个变体，每个
丢给 `tsc -p scratch`（`scratch/` 有自己的 tsconfig，不在 `pnpm check` 的 include 里，
所以故意红的文件不会污染门禁），一次跑完看哪些红。上面第一条结论就是这么推翻的：
先假设"层数是病因"，把层数当变量跑一遍，0 层照样炸 —— 假设当场死掉。

**环境事实**：这台机器上是 **TypeScript 7.0.2（原生 Go 版编译器）**。上面这些坑全是在
tsgo 下测的，跟 TS 5.x 的行为可能不完全一样。

## 门禁的退出码必须是真的（踩过，代价很大）

`pnpm e2e` 曾经**有失败也返回 0**。根因：`run.ts` import `e2e/tlispi.ts` 只为拿
`runSource`，而那个文件的 **CLI 入口是模块级副作用**（住在文件末尾）—— 被 import 时照样
执行，stdin 不是 TTY 就走进"读 stdin"分支，读完写 `process.exitCode = 0`，把断言失败设的
退出码**清掉**。

**规矩：库文件里不许有模块级副作用。入口是入口，库是库**（入口现在住 `e2e/cli.ts`）。

排查这类问题的手法（`process.exitCode` 明明设成了 1、退出码却是 0）：
在设完之后插 `queueMicrotask` + `setTimeout` 各打一次 —— 如果 microtask 时是 1、macrotask
时变成 0，那就是某个定时器/回调改的，顺着去找。

**一条永远说"通过"的门禁比没有门禁更糟**：你还以为它在守。

## 变异测试：`pnpm mutate`（"这门 pass 有没有单测"唯一诚实的度量）

**"测试里出现过这个名字"不等于"有断言"。** 这一轮我用三种查法都问错了：

    按文件名查    `grep -rl "dce"` 匹配到 `global-dce` —— 子串假阳性
    按导出符号查  取到 `REFINED_TAGS` 这类辅助导出 —— 指标本身就坏了
    按管线名字查  16/16 全中，但名字出现 ≠ 有断言

真问题只有一个：**把它改坏，测试会不会红。** `e2e/mutate.ts` 把这句话做成命令。
第一次跑出 16/16"没抓到"，正是因为上面那个退出码缺陷（退出码恒 0）。

三种结果都要当回事：

    ✓ 抓到      有断言在守着
    ✗ 没抓到    **测试有洞** —— 补断言（`dce` / `constant-fold` / `dataflow` 的边界判断
                一开始都是这种），不是把这条变异删掉
    ⚠ 变异过期  那段代码搬走了 → 脚本会静默地什么都不验

### 变异脚本自己必须能活下来（踩过，代价是四十分钟）

变异里**真的会有"让代码不终止"的**（"纯跳转环不判环"就是）。脚本必须扛得住：

1. **子进程一定带超时**。"不终止"也是一种可观察的坏行为，算**抓到**，不算没抓到。
2. **退出时一定还原**：`finally` 之外还要 `process.on("exit")` + `SIGINT/SIGTERM/SIGHUP`。
   **光靠 `finally` 不够** —— 被信号打断时它不跑。这一轮就是：挂住 → 我按中止 →
   变异留在工作区 → 之后**每一次** `node e2e/run.ts` 都跟着挂，看起来像"e2e 坏了"。
3. **"退出码非 0 但一条 ✗ 都没数到"不是"没抓到"** —— 那是变异让代码抛异常、在打印断言
   之前就死了。判成 missed 的话，明明崩了的变异会被报成"没抓到"。

挂住时怎么定位（比猜有效）：在 run.ts 里给每个 `*Checks(` 调用前插一行
`console.error("【进度 N】…")`，跑几秒后杀掉看最后一条 —— 一次就定位到是哪一段。

## 性能纪律：不许出现 O(n²)

范围 = **codegen 生成的代码 + 框架自身 + 融合后的管线**。

每个超线性的地方，要么改掉，要么在代码里写清楚为什么在豁免范围内：

- **① 单个函数/局部作用域内**，n 有界
- **② CFG 局部**，只在自己的块内
- **③ 可并行** —— 纯 map，没有跨元素的顺序依赖

典型要查的六种：

| 坏味道                           | 为什么坏                                            |
| -------------------------------- | --------------------------------------------------- |
| 嵌套遍历同一棵树                 | 每层再走一遍子树                                    |
| 每节点做一次全量查表 / 深比较    | n 个节点 × O(n) 的表                                |
| **不动点判定每次全量深比较**     | 收敛需要 k 轮，就变 O(k·n)；改用结构版本的计数/哈希 |
| 标签 / label 查块用线性扫描      | 用 Map                                              |
| 字符串拼接成数组再 `join`        | 只在常数次时才行                                    |
| 生成代码里对子节点数组做二次扫描 | 一次循环里做完                                      |

每用一次豁免，**必须在审计清单里写明是哪一条、为什么**。

已知还没还的超线性记在 `e2e/perf.ts` 的 `KNOWN_SUPERLINEAR` 里，各带一个任务号。
`pnpm perf` 会把它们标成 △（不失败），**新出现的超线性才是红的**。改完一处就从那张表里删掉。

## 别用 shell 写带 `>` 的文件名

这个仓库的 pass 文件名带 `>`（`x.L6->L7.pass.ts`）。`cat > e2e/passes/x.L6->L7.pass.ts <<EOF`
会被 shell 解释成**重定向**：内容写进 `L7.pass.ts`，真文件一动不动 —— 而且不报错。
我踩过一次，代价是排查了很久一个"改了但没生效"的性能问题。

写这类文件用编辑器的写入工具，或者**给文件名加引号**：`cat > "x.L6->L7.pass.ts"`。

## 结构

```
src/        库。这里不该有任何语言 —— 语言是使用者带来的。
  lang.ts       语言声明 + 类型推导 + derive
  pass.ts       规则 + Rec
  pipeline.ts   管线声明 + 链条校验
  codegen.ts    从语言声明的形状生成遍历器
e2e/        消费者（某个人的编译器）。命名约定只属于这一侧。
  langs/        *.lang.ts
  passes/       *.<from>-><to>.pass.ts / *.<lang>.pass.ts（同语言连做）
  index.nanopass.ts  管线：顺序是人写的，不猜
  pipeline.ts      pipeline("main", steps) —— 管线是**有名字的东西**
  link.ts / gen.ts 把管线链成一个自包含的 .js（pnpm gen）
  linked.ts       运行期入口：所有调用点从产物走，不从源码走
  loops.ts        循环体（fixpoint / rewrite）；产物也用它，所以不能住在各自的闭包里
  fixtures/
  __out__/     链接产物（提交）+ 每步 AST 转储（能重算，不算产物）
```

## 这个项目是什么

nanopass（Dybvig 那套「一层语言一个 pass」的编译器框架）的 TypeScript 版。

- `refs/nanopass-framework-scheme` 是只读参考，Scheme 原版。
- 语言声明是**唯一真相**：节点类型和遍历元数据都从它算出来，没有第二份。
- `derive` 对应 `(extends L)` 加加减产生式，类型层是真合并。
- codegen 只读语言声明的**形状**，不读 handler 的源码、不解析 TS。
