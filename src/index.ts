/**
 * nanopass-ts —— 库的出口。
 *
 * 这里只有框架。语言、pass、管线声明是**使用者带来的**，不在这个包里 ——
 * 库本身不含任何语言。示例/夹具在仓库的 e2e/ 下，那是消费者，不是库。
 */

export * from "./lang.ts";
export * from "./pass.ts";
export * from "./pipeline.ts";
export * from "./codegen.ts";
