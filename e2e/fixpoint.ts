/**
 * 不动点驱动器（t13）。
 *
 * 对应 nanopass 里 `(iterate ... (break when ...))` 那个位置。给传播类 pass 用：
 * 常量传播、全局 DCE、类型传播 —— 它们都是"改一点，可能又暴露出新的可改之处"，
 * 跑一遍不够，要跑到不再变。
 *
 *   fixpoint("fold-to-convergence", constantFold)
 *
 * ## 判定"变没变"：看**根节点引用**，不看内容
 *
 * 一轮跑完，拿到的根节点如果**还是同一个对象**（`===`），那就一步都没改，停。
 *
 * 为什么不深比较（t13 验收④）：深比较是 O(子树大小)，每轮都做一次。跑到不动点要 R 轮，
 * 那就成了 O(n·R)；而且深比较本身还是一场全遍历 —— 跟"再跑一遍 pass"一样贵。引用比较是
 * **一次 `===`**，跟树多大无关。
 *
 * 这个判定的前提是"**没改就返回原对象**"。好消息是这不用每个 pass 自己保证：
 * 生成的遍历器就是这么写的（同语言 pass 下，子节点引用都没变就返回原节点）。
 * 这也是为什么它要求 `from === to` —— 换语言时节点要重新打 `__lang__`，
 * 那时"复用原对象"是语义变化，不是优化。
 *
 * ## 为什么还要轮数上限
 *
 * 跟重写规则同一个理由：**不终止的失败模式是挂住** —— 不报错、不退出，就是永远跑下去。
 * 所以给一个上限，超了报错退出并点名是哪个 pass。
 *
 * 注意这个上限**不是**在防"pass 写错了"：一个真的每轮都改一点的 pass（比如每轮把
 * `(+ x 1)` 改成 `(+ x 1 0)` 再改回来）会一直改下去，引用每次都是新的 —— 那属于 pass
 * 自己的问题。上限的作用是把那种情况变成一句能看懂的报错。
 */

import type { Step } from "./runner.ts";
import { FixpointLimit, fixpointLoop, DEFAULT_MAX_ROUNDS } from "./loops.ts";
export { FixpointLimit };

export interface FixpointStep<F extends string = string, T extends string = string> extends Step<F, T> {
  /** 跑了多少轮才停（诊断用）。 */
  readonly rounds: () => number;
}

/**
 * 把一个（同语言的）step 反复跑到根节点引用不再变。
 *
 * 返回的还是一个 `Step`，能直接进管线 —— arity 沿用被包的 step，所以它跟别的 pass
 * 一样参与融合判定。
 */
export function fixpoint<S extends Step>(
  name: string,
  s: S,
  opts?: {
    maxRounds?: number;
    /**
     * 每次 run 的一次性准备（同 `Step.loop.setup`）—— 被包的 step 如果依赖**每-run 状态**
     * （计数器、环境、"这次 run 才成立"的闭包变量），必须给：`fixpoint` 和链接产物都会
     * **绕过被包 step 的 `run`** 直接调它的 walker，准备不做就会静默地少做事。
     *
     * **现在没有使用者**（`global-const` 是唯一一个，t24 修掉之后它变回普通 `pass()` 了）。
     * 留着是因为反过来删掉的话，下一个这种情况会静默算错 —— 这是 t33 那个坑的钥匙，
     * 别当它是过度设计。
     */
    setup?: (input: unknown) => void;
  },
): FixpointStep<S["from"], S["to"]> {
  if (s.from !== s.to) {
    throw new Error(
      `[${name}] fixpoint 只能包同语言的 step（${s.from} -> ${s.to}）。\n` +
        `  换语言时节点要重新打 __lang__，"没改就复用原对象"那条判定就不成立了。\n` +
        `  要跨语言迭代的话，写成一个同语言的小循环，外面再串换语言的 pass。`,
    );
  }

  const maxRounds = opts?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let lastRounds = 0;

  const setup = opts?.setup;
  /**
   * 循环本身住在 loops.ts（链接产物也要用它重建这一步）。
   *
   * `setup` 先跑：被包的 step 如果依赖每-run 状态（全局常量传播要按输入重算环境），
   * 产物绕过 `run` 直接调 walker 时就会静默地少做事 —— 所以准备必须单独能调。
   */
  const run = (input: unknown): unknown => {
    setup?.(input);
    return fixpointLoop(
      (x) => s.run(x),
      maxRounds,
      name,
      (n) => {
        lastRounds = n;
      },
    )(input);
  };

  return {
    name,
    from: s.from,
    to: s.to,
    arity: s.arity,
    spec: s.spec,
    run,
    // 循环在 run 里 —— 从 spec 重建出来的 walker 只跑一轮
    opaque: true,
    loop: { kind: "fixpoint", maxRounds, ...(setup !== undefined ? { setup } : {}) },
    // 蹦床路径：把内层的 walker（内层自己的 rebuild，或者按 spec 建的）包上这一层循环
    rebuild: (mk) => {
      const inner =
        (
          s as {
            rebuild?: (
              mk: (spec: unknown) => { run: (n: unknown) => unknown },
            ) => (input: unknown) => unknown;
          }
        ).rebuild !== undefined
          ? (s as never as { rebuild: (mk: unknown) => (i: unknown) => unknown }).rebuild(mk)
          : mk(s.spec).run;
      return (input: unknown) => {
        let cur = input;
        for (let round = 1; round <= maxRounds; round++) {
          const next = inner(cur);
          if (next === cur) {
            lastRounds = round - 1;
            return cur;
          }
          cur = next;
        }
        lastRounds = maxRounds;
        throw new FixpointLimit(`[${name}] 跑了 ${maxRounds} 轮还没到不动点 —— 停不下来。`);
      };
    },
    source:
      `// ${name} = fixpoint(${s.name}, maxRounds=${maxRounds})\n` +
      `// 跑到根节点引用不再变为止（引用比较，不是深比较）。\n` +
      s.source,
    rounds: () => lastRounds,
  };
}
