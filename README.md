# 巨幅画布 · Vast Canvas

一个按瓦片（tile）分配像素的绘画内核，加上一个真实可用的绘画窗口。逻辑画布可以远超常驻内存预算（默认 30 000 × 20 000 = 6 亿像素，最大可选 1 000 000 × 1 000 000），但任何时刻都不会分配整幅位图：只有真正被画到或需要显示的瓦片才存在于内存和磁盘。

## 界面怎样启动

界面是一个真正的网页应用（Vite + TypeScript），不是脚本演示。三步：

```bash
npm install        # 安装依赖
npm run dev        # 启动开发服务器
```

然后在浏览器打开终端里打印的地址（默认 **http://127.0.0.1:5173**）。首屏会：

1. 打开 IndexedDB 里的已有工程，没有就新建一个 30 000 × 20 000 的工程；
2. 显示棋盘纸背景和画布边界，左侧面板实时展示瓦片数、常驻内存、内存上限、视口瓦片、本帧绘制/缺失；
3. 准备好画笔即可直接拖动绘制。

操作方式：

| 操作 | 效果 |
| --- | --- |
| 左键拖动 | 连续绘制（跨越多块瓦片） |
| 滚轮 | 以光标为中心缩放 |
| 空格 + 拖动 / 中键 / 右键拖动 | 平移 |
| 侧栏缩放滑杆、＋/－ | 缩放 |
| 「适应窗口」/ `0` 键 | 整幅画布适配视图 |
| `Ctrl/Cmd + Z`、`Ctrl/Cmd + Shift + Z` | 撤销 / 重做 |
| 「导出 PNG」 | 导出真实 PNG 下载 |
| 「新建」+ 画布尺寸下拉 | 新建 8192² / 30k×20k / 250k×180k / 1M² 的工程 |
| 「重开工程」 | 从存储重新加载当前工程，画面完全来自已提交瓦片 |

抬起笔时，整条笔画作为**一个编辑单位**提交：要么所有受影响瓦片都落盘并更新，画面显示完整笔画；要么全部回退到上一状态，画面保持原样并弹出「画布已回退到上一步，未留下半条笔迹」。不会出现半条笔迹。

## 构建 / 生产预览

```bash
npm run build      # tsc 类型检查 + vite build
npm run preview    # 预览生产构建
```

## 测试

```bash
npm test           # 22 个单元测试（vitest）
npm run test:e2e   # 7 个端到端测试（Playwright，驱动真实浏览器）
```

本机（arm64 Linux，无 root）跑 e2e 需要指定自带的 Chromium 与共享库：

```bash
CHROMIUM_PATH=/workspace/.cache-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell \
LD_LIBRARY_PATH=/workspace/.chromedeps/root/usr/lib/aarch64-linux-gnu:/workspace/.chromedeps/root/lib/aarch64-linux-gnu \
npm run test:e2e
```

## 架构

```
src/
  kernel/            与渲染无关的瓦片内核
    geometry.ts      Rect、TileGrid（tileKey/parseKey/tilesForRect/tileRect）
    raster.ts        笔画规划与逐瓦片光栅化；SegmentIndex（按笔画长度而非包围盒）
    brush.ts         唯一权威的笔刷覆盖率函数（内核与测试预言机共用）
    memory.ts        BudgetedLru：按字节上限淘汰，超预算抛错而非静默超限
    document.ts      TiledDocument：解码缓存、原子提交、撤销/重做、整带读回
    transaction.ts   StrokeTransaction：内存受限的组装式笔画事务
    export.ts        readBackBitmap（整带流式导出）、PreviewPyramid（仅显示用）
    mutex.ts         串行化提交/撤销/重做
    errors.ts        InsufficientMemoryError / CommitAbortedError / …
  store/             TileStore 接口 + 三种实现
    memory-store.ts    内存参考实现（单测）
    indexeddb-store.ts 浏览器存储，manifest 单事务原子替换
    fs-store.ts        Node 文件系统，临时文件 + fsync + rename
  render/
    renderer.ts        CanvasRenderer：视口、缩放、逐瓦片 drawImage
    preview-cache.ts   PreviewCache：缩放预览层（派生，绝不参与撤销/导出）
  export/png.ts      无依赖 PNG 编码器（zlib + crc32）
  ui/                main.ts + style.css + index.html：绘画窗口
tests/               reference-canvas.ts 对照实现 + 一致性/原子性/存储/内存测试
e2e/app.spec.ts      Playwright：真实浏览器中的绘制、失败回退、缩放、重开、导出
```

### 关键设计

**稀疏瓦片，按需分配。** 画布尺寸只是一个逻辑边界；`TiledDocument` 里只有 `Map<key, {version}>`。像素只在被画到或需要显示时才从存储解码，解码结果进入 `BudgetedLru`，超预算即淘汰最久未用者。1 000 000² 的工程只画几笔，磁盘占用与内存占用都只和画过的瓦片成正比。

**跨块长笔画的规划。** `planStroke` 把线段按 `pad * 0.75` 细分，只记录每段真正覆盖的瓦片与紧致的整数局部矩形（`floor`/`ceil` 对齐，避免裁掉边缘像素）。工作量与笔画长度成正比，而不是与包围盒面积成正比——45 GP 画布上的长对角线也能在数秒内提交。

**原子提交（全有或全无）。** `commitPreparedLocked` 先把每个受影响瓦片的新版本写入存储（`putTile`），全部完成后才写**一条** manifest 记录指向这些版本。manifest 是根；在此之前任何失败都会删除已暂存版本并返回 `ok:false`，内存与存储都停留在上一状态。因此重载只会看到完整笔画或完全没有，不存在半条笔迹。

**撤销/重做来自已提交版本。** 历史里的每一步记录受影响瓦片的 before/after 版本号；撤销就是把 manifest 的瓦片指针切回 before 版本，像素数据原样恢复。预览层（`PreviewCache`）是从已提交瓦片派生的缩略图，只用于显示，**从不**用于撤销或导出。

**并发与交错。** 提交、撤销、重做共用一个 `AsyncMutex`；撤销会阻塞到进行中的提交完成，绝不会看到暂存中的瓦片。渲染只读不可变的已提交版本，不需要加锁。

**缩放显示而不预分配。** 缩小到一定程度时，一个屏幕像素覆盖许多画布像素，视口里的基础瓦片数量会超过预算。此时 `PreviewCache` 用固定像素预算构建逐级缩略图（每级独立，总量有界），缩小时先画预览层，再把恰好常驻的基础瓦片叠在上面。放大到 1:2 以上则完全走基础瓦片。这也保证了一百万像素见方的画布在「适应窗口」时不会枚举上百万个瓦片键。

### 为什么这不是「把尺寸标签设得很大」

- 没有 `width * height * 4` 的整幅缓冲，任何路径都不会一次性分配整幅位图；
- 单测直接在 250 000 × 180 000（45 GP）和 1 000 000² 上验证峰值内存 ≤ 预算、磁盘占用只与已画瓦片成正比；
- 一致性测试把瓦片内核的局部像素与小尺寸整幅参考实现逐像素对比（含瓦片边界细线、驱逐、长笔画），误差 ≤ 1；
- 原子性测试覆盖暂存失败、manifest 失败、崩溃中断、撤销与提交交错，断言无孤儿瓦片、无历史、无半笔。
