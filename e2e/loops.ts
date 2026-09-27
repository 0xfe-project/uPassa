/**
 * 几步"外挂循环"的**共享实现**（t33）。
 *
 * `rewrite` 和 `fixpoint` 这类 Step 的形状是：**一个遍历器 + 一层循环**。
 * 遍历器部分是从 spec 生成的（链接产物里有），循环部分是几行普通代码。
 *
 * 为什么抽出来：链接产物要能**自己重建**这几步（不然装载/运行时还得 `new Function` 现编
 * walker —— 那就白走编译了）。重建的前提是"循环的语义只有一份"，所以它住在这里，
 * `rewrite()` / `fixpoint()` 和产物都调它。
 *
 * 循环的**参数**（最多几轮、每节点几步）走在 `Step.loop` 上，是数据、可序列化。
 */

/** 改写超了步数预算 —— 大概率是规则在打转。 */
export class RewriteLimit extends Error {}
/** 跑到不动点的轮数超了 —— 每轮都在改东西。 */
export class FixpointLimit extends Error {}

/** 每次改写最多改多少步（按**输入节点数**算，见 `rewriteLoop` 的注释）。 */
export const STEPS_PER_NODE = 32;
export const MIN_MAX_STEPS = 1000;
export const DEFAULT_MAX_ROUNDS = 100;

/** 数一棵树有多少个节点（显式栈：深输入不占原生栈）。 */
export function countNodes(x: unknown): number {
  let n = 0;
  const work: unknown[] = [x];
  while (work.length > 0) {
    const cur = work.pop();
    if (cur === null || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const y of cur) work.push(y);
      continue;
    }
    n += 1;
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (k === "__meta__" || k === "__lang__") continue;
      work.push(v);
    }
  }
  return n;
}

/**
 * 重写的步数预算：给定输入，算出这次允许改多少步。
 *
 * 放在这里是因为**两条路都要用**：`rewrite()` 自己的 `run`，和链接产物重建出来的那一步
 * （产物拿不到 `rewrite()` 的闭包，但它能调 `Step.loop.setup`）。
 */
export function rewriteBudget(input: unknown, fixedMaxSteps: number): number {
  return fixedMaxSteps >= 0 ? fixedMaxSteps : Math.max(MIN_MAX_STEPS, countNodes(input) * STEPS_PER_NODE);
}

/** 跑到不动点：根节点**引用**不再变就停（一次 `===`，不做深比较 —— 见 t13）。 */
export function fixpointLoop(
  inner: (input: unknown) => unknown,
  maxRounds: number,
  name = "fixpoint",
  /** 跑了几轮（诊断用：`fixpoint()` 的 `rounds()` 就是它报的）。 */
  report?: (rounds: number) => void,
): (input: unknown) => unknown {
  return (input: unknown): unknown => {
    let cur = input;
    for (let round = 1; round <= maxRounds; round++) {
      const next = inner(cur);
      if (next === cur) {
        report?.(round - 1); // 最后那一轮什么都没改，不算
        return cur;
      }
      cur = next;
    }
    report?.(maxRounds);
    throw new FixpointLimit(
      `[${name}] 跑了 ${maxRounds} 轮还没到不动点 —— 停不下来。\n` +
        `  每一轮根节点都是新对象，说明这个 pass 每轮都在改东西。\n` +
        `  要么它的改动方向不收敛（改完又被自己改回来），要么它每轮都在无意义地重建节点。`,
    );
  };
}

/**
 * 重写规则的循环：跑到不动点，但**步数预算按输入节点数算**。
 *
 * 为什么不是"一次 run 最多改 N 步"那样的绝对值：大输入合法地需要更多次改写
 * （8000 个函数的程序里光 `x*2 → x+x` 就有 8000 次命中）。"打转"是**每节点**都要改很多次，
 * 收敛的规则集每节点改常数次 —— 按节点算才对得上。
 */
/**
 * 重写规则的循环。
 *
 * **预算不在这里** —— 它在计数器上（handler 每命中一条规则就 +1，超了就抛 `RewriteLimit`，
 * 报错里带得出"最后在改的是哪条规则"）。这里只负责"跑到根节点引用不再变"。
 *
 * 为什么分开：预算的**单位**是"改了多少步"（规则命中次数），循环的单位是"跑了几轮"。
 * 两个单位混在一个数里就说不清了（踩过：把小树算成 1000 轮）。
 */
export function rewriteLoop(
  inner: (input: unknown) => unknown,
  name = "rewrite",
): (input: unknown) => unknown {
  return fixpointLoop(inner, Number.MAX_SAFE_INTEGER, name);
}
