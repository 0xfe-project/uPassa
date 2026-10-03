/**
 * t9 的机制单测：extra formals（往下传）+ extra return values（往上传）。
 *
 * 这个文件不碰 e2e 那套语言 —— 它自己造一个最小的语言，专门压线程模型：
 * 一个子节点吐出来的 extra 直接当下一个兄弟节点的额外参数。
 *
 * 用 `walker.rec` 来观察 extra：pass.run 只把节点交出去（extra 是 pass 内部的通信），
 * 而 rec 带 extra 进来、把元组吐出去，正好是能看到线程的地方。
 */

import { derive, language, list, maybe, type NodeOf } from "../src/nanopass/lang.ts";
import { CodegenError } from "../src/nanopass/codegen.ts";
import { pass, sig } from "../src/nanopass/pass.ts";
import { buildWalker } from "../src/nanopass/codegen.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

// ───────────────────────── 一个最小的语言 ─────────────────────────

const T = language({
  id: "T",
  entry: "E",
  rules: {
    E: {
      Lit: { v: "number" },
      Pair: { a: "E", b: "E" },
      Many: { xs: list("E") },
      Opt: { o: maybe("E") },
    },
  },
});

type E = NodeOf<typeof T, "E">;

/** 每个叶子都长一遍，而且嵌套了 list 和 maybe —— 线程要穿过去。 */
const TREE: E = {
  type: "Pair",
  a: { type: "Lit", v: 1 },
  b: {
    type: "Many",
    xs: [
      { type: "Lit", v: 2 },
      { type: "Opt", o: { type: "Lit", v: 3 } },
      { type: "Opt", o: undefined },
    ],
  },
};

function lits(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const x of node) lits(x, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if (o["type"] === "Lit") out.push(String(o["v"]));
  for (const [k, v] of Object.entries(o)) if (k !== "__meta__") lits(v, out);
  return out;
}

// ───────────────────────── 跑 ─────────────────────────

export function g1Checks(check: Check): void {
  // ① 一个 extra 往下传、往上传；identity 子句负责把它串过兄弟节点
  const one = pass({
    from: T,
    to: T,
    sig: sig(""),
    rules: {
      E: {
        Lit: (n, _rec, acc): [E, string] => [{ type: "Lit", v: n.v + 10 }, `${acc}<${n.v}>`],
      },
    },
  });

  const w1 = buildWalker(one);
  const [out1, acc1] = w1.rec(TREE as never, "");

  check("① extra formal 能往下传任意一串", typeof acc1 === "string");
  check("② extra return 能往上带（穿过了 list 和 maybe）", acc1 === "<1><2><3>", JSON.stringify(acc1));
  check("   节点本身也改了", lits(out1).join(",") === "11,12,13", lits(out1).join(","));

  // ② 两个 extra —— 一个往下传、一个往上数，而且是**多个**返回值
  const two = pass({
    from: T,
    to: T,
    sig: sig("", 0),
    rules: {
      E: {
        Lit: (n, _rec, tag, depth): [E, string, number] => [
          { type: "Lit", v: n.v },
          `${tag}${n.v}`,
          depth + 1,
        ],
      },
    },
  });

  const w2 = buildWalker(two);
  const [out2, acc2, depth2] = w2.rec(TREE, ">", 0);
  // 注意 tag 是**累加进自己**的：">" → ">1" → ">12" → ">123"
  check("② 多个 extra 一起线程", acc2 === ">123" && depth2 === 3, `${JSON.stringify(acc2)} / ${depth2}`);
  check("   节点照旧出来", lits(out2).join(",") === "1,2,3");

  // ③ 递归处同时绑住两个结果（多个返回值解构）+ ④ 列表 helper 把值穿过去
  const threaded = pass({
    from: T,
    to: T,
    sig: sig("", 0),
    rules: {
      E: {
        // 累加要有个来源 —— 没有 handler 的产生式走 identity，extra 原样穿过
        Lit: (n, _rec, tag, depth): [E, string, number] => [
          { type: "Lit", v: n.v },
          `${tag}${n.v}`,
          depth + 1,
        ],
        // 显式递归：两处都同时接住「节点 + 两个 extra」
        Pair: (n, rec, tag, depth): [E, string, number] => {
          // 注解是必须的：rec 的实参是**联合类型**（Expr 有四个产生式）时，
          // TS 推不出干净的返回。这是个已知的类型精度缺口，不是机制问题。
          const [a, t1, d1] = rec(n.a, tag, depth);
          const [b, t2, d2] = rec(n.b, t1, d1);
          return [{ type: "Pair", a, b }, t2, d2];
        },
        // ④ 把一串子节点交给 rec —— 它也得把 extra 串过去。
        // 数组那条路类型上同样还不精确（运行时是对的，见下面断言）。
        Many: (n, rec, tag, depth): [E, string, number] => {
          const [xs, t, d] = rec(n.xs, tag, depth);
          return [{ type: "Many", xs }, t, d];
        },
      },
    },
  });

  const w3 = buildWalker(threaded);
  const [, acc3, depth3] = w3.rec(TREE, "#", 0);
  const leafCount = lits(TREE).length;
  check(
    "③④ 递归处同时接住两个结果 + 列表 helper 串过去",
    acc3 === "#123" && depth3 === leafCount,
    `${JSON.stringify(acc3)} / ${depth3}（期望 ${leafCount}）`,
  );

  // pass 作为一个整体还是「节点进、节点出」—— extra 在 run 那里被丢掉
  const asPass = w3.run(TREE);
  check("pass.run 依旧是节点进节点出", lits(asPass).join(",") === "1,2,3");

  // ⑤ 漏写 handler 不能静默：输出语言里没这个产生式、又没给 handler → 生成期报错
  const TE = language({
    id: "TE",
    entry: "E",
    rules: { E: { Lit: { v: "number" }, Pair: { a: "E", b: "E" }, Opt: { o: maybe("E") } } },
  });
  let err: Error | null = null;
  try {
    buildWalker(pass<typeof T, typeof TE>({ from: T, to: TE, rules: {} }));
  } catch (e) {
    err = e as Error;
  }
  check(
    "⑤ 漏写 handler → 生成期报错，不静默",
    err instanceof CodegenError && (err?.message.includes("Many") ?? false),
    err?.message ?? "（没报错）",
  );

  // 补上 handler 就不该报 —— 生成器只看"有没有 handler"，不看它写了什么。
  // （这条不用 pass() 走类型：同一份递归语言类型在两个泛型上下文里实例化会让 TS 报
  //   "Two different types with this name exist"。生成器要的是形状，直接喂形状。）
  let ok = true;
  try {
    buildWalker({
      from: T,
      to: TE,
      arity: 0,
      rules: { E: { Many: () => ({ type: "Opt", o: undefined }) } },
    } as never);
  } catch {
    ok = false;
  }
  check("   补上 handler 就能生成", ok);
}
