import { FsTileStore } from '../store/fs-store';
import { diagnoseProject } from '../kernel/diagnostics';
import { recoverProject } from '../kernel/recovery';

/**
 * Command-line assistant for the vast canvas. The painting window is the
 * primary interface; this tool only inspects and repairs a file-system store
 * offline:
 *
 *   npm run diagnose -- <store-root>                 list projects
 *   npm run diagnose -- <store-root> <projectId>     verify committed tiles
 *   npm run diagnose -- <store-root> <projectId> --recover
 *         roll back to the last complete canvas and replay what can be
 *         replayed faithfully; unrecoverable strokes are listed as pending
 *
 * Diagnostics read only the store (manifest + tile versions), never a
 * resident canvas, so the conclusions describe the real files on disk.
 */

async function main(): Promise<void> {
  const [root, projectId, ...flags] = process.argv.slice(2);
  if (!root) {
    console.error('用法: npm run diagnose -- <store-root> [projectId] [--recover]');
    process.exitCode = 2;
    return;
  }
  const store = new FsTileStore(root);

  if (!projectId) {
    const projects = await store.listProjects();
    if (projects.length === 0) {
      console.log('（没有工程）');
      return;
    }
    for (const p of projects) {
      console.log(`${p.id}  ${p.width}x${p.height}@${p.tileSize}  ${p.name}`);
    }
    return;
  }

  const report = await diagnoseProject(store, projectId);
  printReport(report);

  if (flags.includes('--recover')) {
    if (report.ok) {
      console.log('\n无需恢复：已提交版本完整。');
      return;
    }
    console.log('\n开始事务回放恢复…');
    const result = await recoverProject({ store, projectId });
    console.log(`回退到最近完整画布：seq ${result.rolledBackToSeq}`);
    for (const r of result.replayed) {
      console.log(`  重放 #${r.fromSeq} → #${r.toSeq}（${r.tool}，${r.tiles} 瓦片，${r.pixels} 像素）`);
    }
    for (const p of result.pending) {
      console.log(`  未决 #${p.seq}：${p.reason}（留给用户处理）`);
    }
    console.log(
      `恢复像素 ${result.recoveredPixels}，瓦片修订 ${result.tileRevisions.length} 处；` +
        `恢复后诊断：缺失 ${result.after.totals.missing}，损坏 ${result.after.totals.corrupt}，残留 ${result.after.totals.orphan}`
    );
    if (!result.complete) {
      console.log('存在无法忠实重放的笔画，已保留在最后完整画布状态。');
      process.exitCode = 1;
    }
  } else if (!report.ok) {
    process.exitCode = 1;
  }
}

function printReport(report: Awaited<ReturnType<typeof diagnoseProject>>): void {
  console.log(`工程 ${report.projectId}`);
  console.log(`  manifest：${report.manifestPresent ? `seq ${report.manifestSeq}` : '不存在'}`);
  console.log(`  引用版本 ${report.referencedVersions} · 存储版本 ${report.storeVersions}`);
  const t = report.totals;
  console.log(`  已提交丢失 ${t.missing} · 字节损坏 ${t.corrupt} · 未提交残留 ${t.orphan}`);
  for (const a of report.missingCommitted) {
    const ref = a.referencedBy[0];
    console.log(
      `    ✗ ${a.key}@v${a.version} ${a.problem === 'missing' ? '缺失' : `字节 ${a.actualBytes}/${a.expectedBytes}`}` +
        ` · ${a.stage === 'committed-current' ? '当前画布' : '撤销载荷'}` +
        ` · ${ref.crossBlock ? '跨块笔画' : '单笔'} #${ref.commitSeq ?? '?'}`
    );
  }
  if (report.truncated) console.log('  （异常列表已按上限截断，计数为精确值）');
  console.log(report.ok ? '结论：已提交数据完整。' : '结论：存在已提交数据丢失。');
}

await main();
