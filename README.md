# temporal-replay-studio-web

订单履约工作流的**重放工作台**。回答一个具体问题：线上跑到一半的几千个履约实例，
它们由旧代码写下的事件历史，交给新代码重放时会不会做出不一样的决定。

没有引入 Temporal/Cadence SDK，也没有使用 xstate 之类的状态机库——确定性检查与
重放判定就是本仓库自己实现的核心。

## 它做什么

- **后端跑工作流**：工作流是注册到后端的 TypeScript 函数，同一工作流可注册多个版本。
  代码里能调度活动、开计时器、并行等待多个活动；失败时把已登记的补偿按相反顺序执行。
- **活动是本地模拟的**：每个活动可配成成功、失败、故意拖到超时，或让完成/超时/取消
  几个终态几乎同时到达。活动有超时与指数退避重试配置。
- **每次运行按序号记录事件**；存储是一个可替换接口（`HistoryStore`），默认进程内实现。
- **时间与随机数都走运行时接口**（`ctx.now()` / `ctx.newDate()` / `ctx.random()`），
  重放时从历史取同一个值。直接调用 `Date.now()` / `new Date()` / `Math.random()` 会被
  两道防线抓住：
  1. 注册时用 TypeScript AST **静态扫描**（带行号，识别局部变量遮蔽）；
  2. 运行/重放时在隔离的 `vm` realm 里设**运行时陷阱**，真正触发即记录
     `DeterminismViolation` 事件（两条路径都能报出来）。
- **重放逐条比对**：拿一段历史交给同一版本或另一版本重新跑，逐条比较这次发出的命令与
  历史记录，覆盖命令类型、参数、以及它消费的历史位置。不一致时返回**第一个分歧点**的
  事件序号、历史期望的命令、新代码实际发出的命令、以及分歧点前后若干条事件，而不是
  一句"结果不同"。
- **显式版本标记** `ctx.version(changeId, current)`：带旧标记的历史交给新代码时返回历史
  里的版本、继续走旧分支，记一条说明，不算分歧；历史里没有该标记则回填最旧版本。
- **终态竞争**：同一活动的完成/超时/取消几乎同时到达时，历史里先到的终态算数，后到的
  丢弃并留下 `ActivityTerminalIgnored` 记录；重放必须得出完全相同的结论。
- **损坏历史**：跳号、截断、引用不存在的活动/计时器/补偿等，在重放前结构校验并结构化
  返回，重放进程不会因此崩溃。

## 页面

- 左侧：事件时间线（蓝点=代码命令，紫点=运行时事件，绿/红=终态，琥珀=被丢弃的终态）。
- 右侧：该时间点的工作流状态、待执行/进行中的命令、等待中的计时器、补偿、版本标记，
  以及当前事件的完整 JSON。
- 播放 / 暂停 / 单步前进后退 / 回起点，以及"跳到第一个分歧点"。
- 播放位置与选中的运行存在 `localStorage`，**刷新后停在原来的事件位置**。

## 快速开始

```bash
npm install
npm run dev        # 同时启动 Express(3001) 与 Vite(5173)
# 打开 http://localhost:5173
```

后端启动时会播种 4 条演示运行：正常履约、失败后倒序补偿、终态竞争、确定性违规。

```bash
npm test           # vitest：引擎 / 投影 / 存储 / HTTP
npm run typecheck  # tsc --noEmit
npm run build      # 构建服务端 CJS bundle + 前端静态资源
npm start          # 单进程同时提供 API 与页面（3001）
```

## API

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | `/api/workflows` | 已注册工作流、版本、静态确定性检查结果 |
| GET  | `/api/runs` | 全部运行摘要（含完整历史） |
| GET  | `/api/runs/:id` | 单次运行 |
| POST | `/api/runs` | 跑一次（body 见 `RunRequest`） |
| POST | `/api/runs/:id/replay` | `{ "version": "v3" }`，返回 `ReplayReport` |

`ReplayReport.status`：`matches` / `diverges` / `corrupt`。分歧时 `divergence` 含
`atSeq`、`expected`、`actual`、`contextBefore`、`contextAfter`。

## 代码结构

```
src/shared/types.ts            事件历史 / 命令 / 报告的共享类型（前后端共用）
src/server/runtime/
  registry.ts                  多版本注册、工作流 DSL 类型（ctx）
  determinism.ts               TS AST 静态扫描 Date/Math
  realm.ts                     vm realm：编译 TS、陷阱 Date/Math、封真实计时器
  rng.ts                       可复现的种子 PRNG
  machine.ts                   统一协程驱动器（命令→事件、活动生命周期、补偿、并行取消）
  live-host.ts                 live：把活动模拟行为变成虚拟时钟上的信号
  replay-host.ts               replay：以历史游标驱动，逐条命令比对、版本标记降级/回填
  history-validator.ts         重放前结构校验（损坏历史绝不崩溃）
src/server/storage/store.ts    可替换 HistoryStore + 默认进程内实现
src/server/workflows/          示例：orderFulfillment v1/v2/v3、paymentRace、nonDeterministic
src/server/{bootstrap,seed,workflow-service,index,paths}.ts
src/web/                       React + Vite：时间线、状态投影、播放控制
src/__tests__/                vitest（引擎/存储/HTTP）；src/web/projection.test.ts
```

## 关键语义备忘

- **命令事件 vs 运行时事件**：`ActivityScheduled`/`TimerScheduled`/`VersionMarker` 等是代码
  发出的命令（重放要比对）；`ActivityStarted`/`ActivityCompleted`/`TimerFired` 等是运行时
  附着到挂起工作上的结果。
- **重放是"读历史"而不是"再模拟一次"**：每次活动尝试的信号从历史终态事件重建，同刻信号
  保持历史中的到达顺序，因此第一个终态获胜、其余被丢弃的结论可逐字节复现。
- **失败的活动尝试**：有退避且未超总时限则发重试堆条目（指数退避）；退避耗尽发
  `ActivityTimedOut`（timeout 类）或直接以失败终态拒绝（普通失败）。
