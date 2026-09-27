/**
 * 管线声明。
 *
 * 顺序是人写的 —— 不猜、不扫文件夹、不从文件名推。linker 的职责是**校验**。
 * 这里能校验的东西尽量塞进类型，因为那样错误在 tsc 就报出来了，不用等 link。
 */

import type { LangDecl, NodeOf } from "./lang.ts";
import type { Pass } from "./pass.ts";

// ───────────────────────── 类型层：链条 ─────────────────────────

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type PassLike = { readonly from: LangDecl; readonly to: LangDecl };

/** passes[i].to 必须等于 passes[i+1].from。 */
export type ChainOk<P extends readonly PassLike[]> = P extends readonly []
  ? true
  : P extends readonly [infer H, ...infer T]
    ? H extends PassLike
      ? T extends readonly PassLike[]
        ? T extends readonly []
          ? true
          : T extends readonly [infer N, ...infer _]
            ? N extends PassLike
              ? Equal<H["to"], N["from"]> extends true
                ? ChainOk<T>
                : false
              : false
            : false
        : false
      : false
    : false;

/** entry 必须等于第一个 pass 的 from。 */
export type EntryOk<E extends LangDecl, P extends readonly PassLike[]> = P extends readonly [
  infer H,
  ...infer _,
]
  ? H extends PassLike
    ? Equal<E, H["from"]>
    : false
  : true;

/** 链尾的 pass，用来算整条管线的输出语言。 */
export type Last<P extends readonly PassLike[]> = P extends readonly []
  ? never
  : P extends readonly [infer H, ...infer T]
    ? T extends readonly []
      ? H
      : Last<T & readonly PassLike[]>
    : never;

type Broken = {
  readonly "pass chain broken: entry must equal passes[0].from, and passes[i].to must equal passes[i+1].from": never;
};

type Check<E extends LangDecl, P extends readonly PassLike[]> =
  ChainOk<P> extends true ? (EntryOk<E, P> extends true ? unknown : Broken) : Broken;

// ───────────────────────── 声明 ─────────────────────────

export interface Pipeline<E extends LangDecl, P extends readonly PassLike[]> {
  readonly entry: E;
  readonly passes: P;
  /** 入口节点 → 最后一个 pass 的输出节点。codegen 生成。 */
  readonly run: (input: NodeOf<E, E["entry"]>) => unknown;
}

/**
 *   export default pipeline({
 *     entry: Lsrc,
 *     passes: [removeOneArmedIf, ...],
 *   });
 */
export function pipeline<const E extends LangDecl, const P extends readonly PassLike[]>(
  spec: { readonly entry: E; readonly passes: P } & Check<E, P>,
): Pipeline<E, P> {
  return {
    ...spec,
    run: () => {
      throw new Error("pipeline.run 由 codegen 生成");
    },
  };
}
