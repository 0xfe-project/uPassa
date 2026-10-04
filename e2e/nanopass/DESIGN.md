# Nanopass Language Chain Design

## 目标

测试 nanopass 框架的核心功能：
- 语言定义 (`language()`)
- 语言派生 (`derive()`)
- Pass 转换 (`pass()`)
- 模式匹配和遍历

## 语言链

```
L0 (源语言)
  ↓ [desugar-let]
L1 (移除 let，只保留 lambda)
  ↓ [explicit-refs]
L2 (引用显式化)
  ↓ [flatten]
L3 (扁平化表达式)
```

### L0: 源语言

包含：
- 变量 `(var name)`
- lambda `(lambda (param) body)`
- 应用 `(app func arg)`
- let 绑定 `(let ([name val]) body)`
- 算术 `(+ a b)`, `(* a b)`
- 字面量 `(int n)`

### L1: 去糖后

移除 `let`，转换为 lambda 应用：
```scheme
(let ([x 1]) body)
=>
((lambda (x) body) 1)
```

### L2: 引用显式化

为每个变量引用添加绑定深度信息：
```scheme
(var name)
=>
(ref name depth)
```

### L3: 扁平化

将嵌套表达式提取为 let 绑定：
```scheme
(+ (+ 1 2) 3)
=>
(let ([t1 (+ 1 2)])
  (+ t1 3))
```

## 测试计划

1. **语言定义测试**：验证每个语言的类型定义正确
2. **派生测试**：验证 `derive()` 正确继承和修改
3. **Pass 测试**：验证每个 pass 的转换正确
4. **端到端测试**：完整的链式转换

## 实现顺序

1. 定义 L0-L3 语言 (t16)
2. 实现 passes (t17)
3. 编写测试 (t18-t20)
