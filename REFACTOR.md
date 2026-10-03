# 重构计划

## 目标

把项目从单一 nanopass 框架重构为双层代码生成框架：
1. nanopass 层：树重写
2. SSA 层：图优化

项目名：**uPassa** (nano pass + ssa)

---

## 架构

```
nanopass 层（树重写）
  ↓
  用户自己写降低逻辑
  ↓
SSA 层（图优化）
```

两层独立，不强制绑定。

---

## 框架提供什么

### nanopass 层
- `language()` + `derive()` 声明语言
- `pass()` 声明树变换规则
- codegen：生成类型安全的树 walker
- fusion：多个 pass 合一

### SSA 层
- Braun 算法：树 → SSA
- 基础设施：支配树、use-def 链、循环识别
- SSA pass 声明接口
- codegen：生成图 walker
- pass manager：调度、依赖管理

**不提供**：具体的优化 pass（用户自己写）

---

## SSA IR：φ 节点

理由：对接 LLVM/GCC 方便。

---

## 目录结构

```
upassa/
├── src/
│   ├── nanopass/
│   │   ├── lang.ts
│   │   ├── pass.ts
│   │   ├── pipeline.ts
│   │   ├── codegen.ts
│   │   └── index.ts
│   ├── ssa/
│   │   ├── braun.ts
│   │   ├── ir.ts
│   │   ├── pass.ts
│   │   ├── codegen.ts
│   │   ├── pass-manager.ts
│   │   ├── verify.ts
│   │   ├── analysis/
│   │   │   ├── domtree.ts
│   │   │   ├── loops.ts
│   │   │   └── usedef.ts
│   │   └── index.ts
│   └── index.ts
│
└── e2e/
    ├── nanopass/
    │   ├── langs/
    │   ├── passes/
    │   ├── pipeline.ts
    │   └── tests/
    └── ssa/
        ├── passes/        # 测试用的 pass（不是框架交付的）
        ├── pipeline.ts
        └── tests/
```

---

## e2e 完全重写

不是删改现有的，从头设计。

### nanopass 侧

#### 语言链条（拆细）

去糖 + 结构变换，每个 pass 只做一件事。

参考闭包转换拆分：
```
Lsrc
  ↓ mark-lambda-free          标记自由变量
L1
  ↓ box-mutable               被 set! 的变量 → box
L2
  ↓ optimize-known-call       标记已知函数调用
L3
  ↓ name-anonymous-lambda     所有 lambda 命名化
L4
  ↓ flatten-binding           let/letrec 扁平化
L5
  ↓ convert-closure           lambda → closure record
L6
  ↓ insert-closure-prim       插入 make-closure 原语
L7
  ↓ lift-closure              提升到顶层
L8
  ↓ a-normalize               ANF 变换（表达式 → 赋值序列）
L9
  ↓ explicit-control-flow     if → label + branch
L10  (可降低到 SSA 的形式)
```

**关键**：
- 闭包转换拆成 5~8 个 pass
- ANF、CPS 也类似拆细
- 验证框架能处理复杂的多步重写

#### 测试重点
- fusion 正确性（拆细的 pass 融合后等价）
- 类型安全
- 性能（O(n)）
- 深度嵌套不爆栈

---

### SSA 侧

#### 提供的东西
- Braun 算法
- 支配树、use-def 链、循环识别
- pass manager 框架

#### e2e 需要的 pass（只在测试里）
- SimplifyCFG
- DCE
- SCCP
- Mem2Reg

**这些 pass 不是框架交付的**，只是用来测试：
- SSA codegen 生成的图 walker 能用
- pass manager 调度正确
- 基础设施（支配树、use-def）正确

#### 测试重点
- Braun 算法正确性（φ 节点位置、SSA 不变式）
- 支配树算法正确性
- pass manager 依赖管理
- 性能

---

## 删除的东西

### 全删
- `e2e/` 下所有现有文件（完全重写）
- CFG 相关（`cfg.ts`、`cfg-passes.ts`、`lower-cfg.ts`、`dataflow.ts`）
- L7、Lcfg 语言层

### 理由
- e2e 从头设计，不在旧结构上改
- CFG 是多余层（Braun 可以直接从树构造 SSA）

---

## 重构步骤

1. 重组 `src/` 目录结构
2. 删除所有 `e2e/` 内容
3. 实现 SSA 层基础（Braun、支配树、验证器）
4. 实现 SSA codegen
5. 重写 e2e/nanopass（拆细的 pass 链）
6. 重写 e2e/ssa（测试用的 pass）
7. 文档

---

## nanopass 的 pass 粒度示例

### 错误：一个 pass 做完闭包转换
```
pass("closure-conversion", /* 几百行 */)
```

### 正确：拆成 5~8 个小 pass
```
pass("mark-lambda-free")      只标记自由变量
pass("box-mutable")           只处理 set!
pass("optimize-known-call")   只标记调用
pass("name-anonymous-lambda") 只给 lambda 命名
pass("flatten-binding")       只扁平化绑定
pass("convert-closure")       只转换 lambda → closure
pass("insert-closure-prim")   只插入原语
pass("lift-closure")          只提升到顶层
```

每个独立测试、独立 fusion。

---

## 时间线

- 重组目录：3 天
- SSA 基础：1 周
- SSA codegen：1.5 周
- e2e/nanopass：1 周
- e2e/ssa：1 周
- 文档：3 天

总计：约 5 周

---

## 下一步

1. 确认这份计划
2. 开始重组 `src/` 目录
3. 删除旧 `e2e/`
4. 实现 SSA 层
