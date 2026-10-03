/**
 * 全局 DCE：删掉从入口不可达的顶层定义（t14）。
 *
 *   (define used   (lambda (x) x))      保留（body 调它）
 *   (define unused (lambda (x) x))      删掉（没人引用）
 *   (used 1)
 *
 * 和 `dce.L7.pass.ts` 的分工：那条管**局部**的（`let` 里没人用的绑定），这条管**顶层**的
 * （整个定义没人要）。两条都需要，管的是不同的东西。
 *
 * ── 为什么可以删（这个语言没有副作用）
 *
 * 顶层定义只在被求值时才有效果，而这个语言的表达式**没有副作用** —— 没有 print、
 * 没有 set!。所以"没人引用的定义"删掉之后，程序的值一个字都不变。
 *
 * 这一点是**前提**，不是巧合：真语言里有副作用（比如 `(define _ (print 1))`）就不能这么删。
 * 所以如果哪天给这语言加了 print，这条 pass 必须先改回来。写在文件头，免得后来的人踩。
 *
 * ── 入口是 body，不是所有定义
 *
 * `Program.body` 里那些表达式才是"要算的东西"；`defs` 只是定义。所以可达性从 body 出发，
 * 顺着引用一路走。自引用（递归）当然也算可达，所以递归函数不会被误删。
 *
 * ── 作用域：被遮蔽的引用不算引用
 *
 * `(define x 1) … (let ((x 2)) x)` 里那个 `x` 指的是局部绑定，**不是**全局的 x。
 * 所以扫描时要跟着作用域走（进 `let`/`lam`/`letrec` 就把名字记上）。
 * 不这么做的话也不算错（顶多是少删几个），但那叫"因为懒所以不精确"，不是"保守"。
 *
 * ── 不需要跑到不动点
 *
 * 可达性是**传递闭包**，一个 worklist 一次就求完了 —— 不像常量传播那样"改一点又冒出新的
 * 可改之处"。所以这条不包 `fixpoint`。
 */

import { L7 } from "../langs/L7.lang.ts";
import { pass } from "../../src/nanopass/pass.ts";
import type { NodeOf } from "../../src/nanopass/lang.ts";
import { step } from "../runner.ts";

type Program = NodeOf<typeof L7, "Program">;

type Node = Record<string, unknown>;

/**
 * 收集一个表达式里被引用的名字；`bound` 是当前可见的局部名字。
 *
 * **显式栈**，不是递归 —— 深输入（十万层 Call 链）下递归会爆原生栈。这个仓库对
 * 这条限制的态度是"明确报错"或者"根本别产生"（t27 / t18），不是"看运气"。
 */
function collect(x: unknown, bound: ReadonlySet<string>, sink: (name: string) => void): void {
  // 每项是 [节点, 当前作用域]
  const work: [unknown, ReadonlySet<string>][] = [[x, bound]];
  while (work.length > 0) {
    const [cur, scope] = work.pop()!;
    if (cur === null || typeof cur !== "object") continue;

    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) work.push([cur[i], scope]);
      continue;
    }

    const n = cur as Node;
    switch (n["type"]) {
      case "Var": {
        const name = String(n["name"]);
        if (!scope.has(name)) sink(name);
        continue;
      }
      case "Lam": {
        // 参数遮蔽；参数本身不是引用
        const inner = new Set(scope);
        for (const p of (n["params"] ?? []) as { name: string }[]) inner.add(p.name);
        work.push([n["body"], inner]);
        continue;
      }
      case "Let": {
        // let 是平行的：绑定值在**外层**环境里求
        const binds = (n["bindings"] ?? []) as Node[];
        for (const b of binds) {
          work.push([b["value"], scope]);
          work.push([b, scope]); // b 本身也要走（里面可能有别的字段）
        }
        const inner = new Set(scope);
        for (const b of binds) inner.add(String(b["name"]));
        work.push([n["body"], inner]);
        continue;
      }
      case "Letrec": {
        // letrec 的绑定互相可见
        const inner = new Set(scope);
        for (const b of (n["bindings"] ?? []) as Node[]) inner.add(String(b["name"]));
        for (const b of (n["bindings"] ?? []) as Node[]) work.push([b["value"], inner]);
        work.push([n["body"], inner]);
        continue;
      }
      default: {
        // 其余节点按字段通用地走 —— 不列白名单，免得以后加了新产生式就漏（漏了会**误删**，
        // 那是最坏的错法）。带 __ 的是框架元数据，跳过。
        for (const [k, v] of Object.entries(n)) {
          if (k.startsWith("__")) continue;
          if (k === "name" || k === "params" || k === "bindings" || k === "names") continue;
          work.push([v, scope]);
        }
        continue;
      }
    }
  }
}

/** 从入口算出可达的顶层名字。 */
function reachableNames(prog: { defs: { name: string; value: unknown }[]; body: unknown[] }): Set<string> {
  const byName = new Map(prog.defs.map((d) => [d.name, d.value] as const));
  const seen = new Set<string>();
  const queue: string[] = [];
  const note = (name: string): void => {
    if (!byName.has(name) || seen.has(name)) return;
    seen.add(name);
    queue.push(name);
  };

  const EMPTY: ReadonlySet<string> = new Set();
  for (const e of prog.body) collect(e, EMPTY, note);
  while (queue.length > 0) {
    const name = queue.pop()!;
    collect(byName.get(name), EMPTY, note);
  }
  return seen;
}

/**
 * 这条以前也是手搭的 Step（`opaque: true`，`rules` 是空的）—— 同上，`Program` 规则
 * 写不出来。现在它就是一条普通的 `Program` 规则。
 *
 * 规则里**不调 `rec`**：这条 pass 只重写顶层的 `defs` 列表，函数体一个字都不动。
 * 不往下走不是省事 —— 走了也只是把同一批对象原样收回来（identity 那条路）。
 */
export const globalDce = step(
  "global-dce",
  pass({
    from: L7,
    to: L7,
    rules: {
      Program: {
        Prog: (n): Program => {
          // **没有 body 就不删。** 这时候"入口"根本不存在 —— 一个只有定义的程序是**库**，
          // 定义一个函数出来本身就是目的（REPL 里敲一句 `(define (f x) x)` 就是这个形状）。
          // 按"没人引用"把它删掉是错的，不是保守。踩过一次：perf 的深度用例只有定义，
          // 结果整棵树被删空，量出来"输出 0 条"。
          if (n.body.length === 0) return n;
          const alive = reachableNames(n as never);
          const kept = n.defs.filter((d) => alive.has(d.name));
          // 一个都没删 → 返回**原对象**（省一次分配，也让"变没变"一次 `===` 就能看出来）
          if (kept.length === n.defs.length) return n;
          return { ...n, defs: kept } as Program;
        },
      },
    },
  }),
);
