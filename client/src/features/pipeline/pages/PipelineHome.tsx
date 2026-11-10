import { useEffect, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { EmptyState, InlineSpinner, useToast } from '../../../shared/ui';
import type { PipelineSchemaResult, PipelineStage, PipelineState } from '../../../shared/types/ipc';
import { AGENT_NAMES, PIPELINE_STATUS_LABELS, STATUS_META, TEAM_CONTRACTS, type TeamContract } from '../types';

function readStageOutputs(stage: PipelineStage): Record<string, unknown> {
  return stage.outputs && typeof stage.outputs === 'object' ? (stage.outputs as Record<string, unknown>) : {};
}

function stageDuration(stage: PipelineStage): number | null {
  if (!stage.started_at || !stage.updated_at) return null;
  const start = new Date(stage.started_at).getTime();
  const end = new Date(stage.updated_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function summarizeOutputs(outputs: unknown): string {
  if (outputs === null || outputs === undefined) return '暂无产物';
  if (typeof outputs !== 'object') return String(outputs);
  const record = outputs as Record<string, unknown>;
  if (record.placeholder && typeof record.note === 'string') return record.note;
  const parts: string[] = [];
  const count = (key: string, label: string) => {
    const list = record[key];
    if (Array.isArray(list) && list.length) parts.push(`${label} ${list.length} 条`);
  };
  count('qualification', '资格条件');
  count('substantive', '实质性条款');
  count('technical', '技术要求');
  count('commercial', '商务要求');
  count('checks', '资格核查');
  count('gaps', '材料缺口');
  count('topics', '技术主题');
  count('sections', '正文章节');
  count('issues', '质检问题');
  count('laws', '法规');
  count('cases', '案例');
  count('risks', '风险提示');
  count('sources', '来源');
  count('notes', '注意事项');
  if (typeof record.score === 'number') parts.push(`一致性评分 ${record.score}`);
  if (typeof record.passed === 'boolean') parts.push(record.passed ? '质检通过' : '质检未通过');
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (summary) parts.push(`概要：${summary}`);
  return parts.length ? parts.join('，') : '阶段产物已写入共享黑板。';
}

function formatOutputsJson(outputs: unknown): string {
  if (outputs === null || outputs === undefined) return '';
  try {
    return JSON.stringify(outputs, null, 2);
  } catch {
    return String(outputs);
  }
}

interface StageCardProps {
  index: number;
  stage: PipelineStage;
  note: string;
  busy: boolean;
  onNoteChange: (stageKey: string, note: string) => void;
  onApprove: (stageKey: string) => void;
  onReject: (stageKey: string) => void;
}

function StageCard({ index, stage, note, busy, onNoteChange, onApprove, onReject }: StageCardProps) {
  const meta = STATUS_META[stage.status] ?? STATUS_META.pending;
  const approval = stage.approval;
  const isWaiting = stage.status === 'waiting_approval';
  // 终审闸门没有执行节点：通过即签发成稿并解锁导出，打回则退回生成节点按意见重写。
  const isFinalGate = stage.stage_key === 'final_approval';
  const recentLogs = stage.logs.slice(-3);
  const outputsJson = formatOutputsJson(stage.outputs);
  // 一致性阶段的逐条比对报告：人工复审时直接看表，不用翻 JSON。
  const comparisonRows = Array.isArray((stage.outputs as Record<string, unknown> | null)?.comparison)
    ? ((stage.outputs as Record<string, unknown>).comparison as Array<{
        item?: string;
        required?: string;
        status?: string;
        evidence?: string;
        anchor?: string;
      }>)
    : [];
  const comparisonStats = comparisonRows.reduce(
    (acc, row) => {
      if (row.status === 'responded') acc.responded += 1;
      else if (row.status === 'partial') acc.partial += 1;
      else if (row.status === 'missing') acc.missing += 1;
      else acc.na += 1;
      return acc;
    },
    { responded: 0, partial: 0, missing: 0, na: 0 },
  );
  const comparisonTone: Record<string, string> = {
    responded: '已响应',
    partial: '部分响应',
    missing: '未响应',
    'n/a': '不适用',
  };
  // 复审模式没有招标文件条款，比对基准是成稿自身，结论只能用于发现内部不一致。
  const auditMeta = (stage.outputs as Record<string, unknown> | null)?._audit as
    | { baselineMissing?: boolean }
    | undefined;
  const baselineMissing = auditMeta?.baselineMissing === true;

  return (
    <section className={`pipeline-stage ${meta.tone}`}>
      <header className="pipeline-stage-head">
        <span className="pipeline-stage-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="pipeline-stage-title">
          <h3>{stage.label}</h3>
          <span className="pipeline-stage-agent">{AGENT_NAMES[stage.agent_id] ?? `Agent ${stage.agent_id}`}</span>
        </div>
        <span className={`pipeline-badge ${meta.tone}`}>{meta.label}</span>
      </header>

      <p className="pipeline-stage-summary">
        {summarizeOutputs(stage.outputs)}
        <span className="pipeline-stage-duration">耗时 {formatDuration(stageDuration(stage))}</span>
      </p>

      {outputsJson ? (
        <details className="pipeline-stage-outputs">
          <summary>查看阶段产物</summary>
          <pre>{outputsJson}</pre>
        </details>
      ) : null}

      {comparisonRows.length > 0 ? (
        <details className="pipeline-stage-outputs" open>
          <summary>
            逐条比对报告（{comparisonRows.length} 条）
            <span className="pipeline-comparison-legend">
              已响应 {comparisonStats.responded} · 部分响应 {comparisonStats.partial} · 未响应{' '}
              {baselineMissing ? '—（无招标基准）' : comparisonStats.missing}
              {comparisonStats.na > 0 ? ` · 评分项不适用 ${comparisonStats.na}` : ''}
            </span>
          </summary>
          {baselineMissing ? (
            <p className="pipeline-comparison-note">
              复审模式未加载招标文件条款，比对基准是成稿自身，只能发现内部不一致，不能替代对招标文件的响应性核查。
            </p>
          ) : null}
          <div className="pipeline-comparison">
            {comparisonRows.slice(0, 40).map((row, rowIndex) => (
              <div className="pipeline-comparison-row" key={`${row.item}-${rowIndex}`}>
                <span className="pipeline-comparison-item">
                  <em>{row.required || '要求'}</em>
                  {row.item}
                </span>
                <span className={`pipeline-comparison-status is-${row.status === 'n/a' ? 'na' : row.status || 'missing'}`}>
                  {comparisonTone[row.status || 'missing'] ?? '未响应'}
                </span>
                <span className="pipeline-comparison-evidence">{row.evidence || '—'}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {recentLogs.length > 0 ? (
        <ul className="pipeline-stage-logs">
          {recentLogs.map((log, logIndex) => (
            <li key={`${log.at}-${logIndex}`}>{log.message}</li>
          ))}
        </ul>
      ) : null}

      {approval.decision === 'approved' ? (
        <p className="pipeline-approval-note">已通过确认{approval.note ? `：${approval.note}` : ''}</p>
      ) : null}
      {approval.decision === 'rejected' ? (
        <p className="pipeline-approval-note is-rejected">已打回重跑{approval.note ? `：${approval.note}` : ''}</p>
      ) : null}

      {isWaiting ? (
        <div className="pipeline-gate">
          <label className="pipeline-gate-label" htmlFor={`gate-note-${stage.stage_key}`}>
            人工闸门意见（可选）
          </label>
          <textarea
            id={`gate-note-${stage.stage_key}`}
            className="pipeline-gate-note"
            value={note}
            placeholder="填写通过说明或打回原因"
            onChange={(event) => onNoteChange(stage.stage_key, event.target.value)}
          />
          <div className="pipeline-gate-actions">
            <button type="button" className="primary-action" disabled={busy} onClick={() => onApprove(stage.stage_key)}>
              {isFinalGate ? '终审通过并签发成稿' : '通过并进入下一阶段'}
            </button>
            <button type="button" className="danger-action" disabled={busy} onClick={() => onReject(stage.stage_key)}>
              {isFinalGate ? '打回重写受影响章节' : '打回重跑本阶段'}
            </button>
          </div>
          {isFinalGate ? (
            <p className="pipeline-approval-note">通过后才会解锁「导出投标文档（Word）」，未签发前导出会被拦截。</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TeamCard({ contract }: { contract: TeamContract }) {  return (
    <article className="pipeline-team-card">
      <header className="pipeline-team-head">
        <span className="pipeline-team-role">{contract.role}</span>
        <h4>{AGENT_NAMES[contract.agentId] ?? `Agent ${contract.agentId}`}</h4>
      </header>
      <dl className="pipeline-team-body">
        <div>
          <dt>工具集</dt>
          <dd>{contract.tools.join('、')}</dd>
        </div>
        <div>
          <dt>输入</dt>
          <dd>{contract.inputs.join('、')}</dd>
        </div>
        <div>
          <dt>输出产物</dt>
          <dd>{contract.outputs.join('、')}</dd>
        </div>
        {contract.dependsOn.length > 0 ? (
          <div>
            <dt>上游依赖</dt>
            <dd>{contract.dependsOn.join('、')}</dd>
          </div>
        ) : null}
        {contract.parallelGroup ? (
          <div>
            <dt>并行分组</dt>
            <dd>analysis（与同组阶段并行执行）</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

export default function PipelineHome() {
  const { showToast } = useToast();
  const [state, setState] = useState<PipelineState | null>(null);
  const [overview, setOverview] = useState('');
  const [companyProfile, setCompanyProfile] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [busyStageKey, setBusyStageKey] = useState<string | null>(null);
  const [tenderInfo, setTenderInfo] = useState<{ fileName?: string; chars?: number; parserLabel?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 辅线：人工上传/粘贴已写好的标书，跳过解析与生成，只跑一致性检查。
  const [reviewText, setReviewText] = useState('');
  const [reviewInfo, setReviewInfo] = useState<{ fileName?: string; chars?: number; parserLabel?: string } | null>(null);
  const [pickingReview, setPickingReview] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [schema, setSchema] = useState<PipelineSchemaResult | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    trackPageView('pipeline');
    let mounted = true;
    void window.yibiao?.pipeline
      ?.getState()
      .then((cached) => {
        if (mounted && cached) {
          setState(cached);
          if (cached.tender) setTenderInfo({ fileName: cached.tender.fileName, chars: cached.tender.chars, parserLabel: cached.tender.parserLabel });
        }
      })
      .catch(() => undefined);
    const unsubscribe = window.yibiao?.pipeline?.onEvent((next) => {
      if (mounted && next) {
        setState(next);
        if (next.tender) setTenderInfo({ fileName: next.tender.fileName, chars: next.tender.chars, parserLabel: next.tender.parserLabel });
      }
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const stages = state?.stages ?? [];
  const pipelineActive = state?.active ?? false;
  const pipelineStatus = state?.status ?? 'idle';
  const isEmpty = stages.length === 0;

  const generateStage = stages.find((item) => item.stage_key === 'generate');
  const finalStage = stages.find((item) => item.stage_key === 'final_approval');
  // 导出前置条件：生成阶段成功 + 终审已签发（人工确认）。
  const exportReady = state?.exportReady === true || finalStage?.approval?.decision === 'approved';
  const canExport = generateStage?.status === 'success' && exportReady;
  const consistency = stages.find((item) => item.stage_key === 'consistency');
  const consistencyOut = consistency ? readStageOutputs(consistency) : {};
  const successCount = stages.filter((item) => item.status === 'success').length;
  // 人工复审会跳过解析/资格/技术/法规，通过率只按实际执行的阶段算。
  const countedStages = stages.filter((item) => item.status !== 'skipped');
  const skippedCount = stages.length - countedStages.length;
  const passRate = countedStages.length ? Math.round((successCount / countedStages.length) * 100) : null;
  const score = typeof consistencyOut.score === 'number' ? consistencyOut.score : null;
  const passed = typeof consistencyOut.passed === 'boolean' ? consistencyOut.passed : null;
  const reworkMetrics =
    consistencyOut._metrics && typeof consistencyOut._metrics === 'object'
      ? (consistencyOut._metrics as Record<string, unknown>)
      : {};
  const reworkRounds = typeof reworkMetrics.reworkRounds === 'number' ? reworkMetrics.reworkRounds : null;
  const reworkHistory = Array.isArray(reworkMetrics.history)
    ? (reworkMetrics.history as Array<{ round?: number; score?: number | null; highCount?: number }>)
    : [];
  const firstReworkScore = typeof reworkHistory[0]?.score === 'number' ? reworkHistory[0].score : null;
  const scoreDelta = firstReworkScore !== null && score !== null ? `${firstReworkScore} → ${score}` : null;
  const openHighIssues = Array.isArray(consistencyOut.issues)
    ? (consistencyOut.issues as Array<{ severity?: string }>).filter((issue) => issue?.severity === 'high').length
    : 0;
  const reviewChars = reviewText.trim().length;

  const handleImportTender = async () => {
    if (importing || pipelineActive) return;
    setImporting(true);
    try {
      const result = await window.yibiao.pipeline.importTender();
      if (result.success) {
        setTenderInfo({ fileName: result.fileName, chars: result.chars, parserLabel: result.parserLabel });
        showToast(result.message || '招标文件已解析', 'success');
      } else {
        showToast(result.message || '招标文件解析失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '上传招标文件失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleExportDraft = async () => {
    if (exporting || pipelineActive) return;
    if (!exportReady) {
      showToast('终审尚未签发：请先在「终审签发」闸门通过，确认成稿可提交后再导出。', 'info');
      return;
    }
    setExporting(true);
    try {
      const result = await window.yibiao.pipeline.exportDraft();
      if (result.success) {
        showToast(result.message || '投标文档已导出', 'success');
      } else if (result.canceled) {
        showToast('已取消导出', 'info');
      } else {
        showToast(result.message || '导出 Word 失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出 Word 失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleStart = async () => {
    const overviewTrim = overview.trim();
    const companyTrim = companyProfile.trim();
    if (!overviewTrim && !companyTrim) {
      showToast('未填写项目概述或资质概况；若工作区也未上传招标文件，解析阶段将无材料可分析。', 'info');
    }
    setStarting(true);
    try {
      const next = await window.yibiao.pipeline.start({
        projectOverview: overviewTrim,
        companyProfile: companyTrim,
      });
      setState(next);
      showToast('多 Agent 流水线已启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动流水线失败', 'error');
    } finally {
      setStarting(false);
    }
  };

  const runApproval = async (stageKey: string, decision: 'approve' | 'reject') => {
    setBusyStageKey(stageKey);
    const note = notes[stageKey]?.trim();
    try {
      const action = decision === 'approve' ? window.yibiao.pipeline.approve : window.yibiao.pipeline.reject;
      const next = await action({ stageKey, note });
      setState(next);
      showToast(decision === 'approve' ? '已通过确认，进入下一阶段' : '已打回，将重新执行本阶段', decision === 'approve' ? 'success' : 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '闸门操作失败', 'error');
    } finally {
      setBusyStageKey(null);
    }
  };

  const handlePickReviewDraft = async () => {
    if (pickingReview || pipelineActive) return;
    setPickingReview(true);
    try {
      const result = await window.yibiao.pipeline.pickReviewDraft();
      if (result.success && result.text) {
        setReviewText(result.text);
        setReviewInfo({ fileName: result.fileName, chars: result.chars, parserLabel: result.parserLabel });
        showToast(result.message || '标书已读取，可直接提交复审', 'success');
      } else {
        showToast(result.message || '读取标书失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取标书失败', 'error');
    } finally {
      setPickingReview(false);
    }
  };

  const handleSubmitReview = async () => {
    if (submittingReview || pipelineActive) return;
    const text = reviewText.trim();
    if (!text) {
      showToast('请先上传或粘贴需要复审的标书正文', 'info');
      return;
    }
    setSubmittingReview(true);
    try {
      const next = await window.yibiao.pipeline.submitReview({
        text,
        fileName: reviewInfo?.fileName,
        projectOverview: overview.trim(),
        companyProfile: companyProfile.trim(),
        strictConsistency: true,
      });
      setState(next);
      showToast('已提交复审：跳过解析与生成，直接进入一致性检查', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '提交复审失败', 'error');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleLoadSchema = async () => {
    if (schemaLoading) return;
    setSchemaLoading(true);
    try {
      const result = await window.yibiao.pipeline.getSchema();
      setSchema(result);
      if (!result.success) showToast(result.message || '节点输出结构不可用', 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '节点输出结构不可用', 'error');
    } finally {
      setSchemaLoading(false);
    }
  };

  return (
    <div className="pipeline-page">
      <div className="pipeline-scroll">
        <header className="pipeline-header">
          <div>
            <h2 className="pipeline-title">多 Agent 流水线</h2>
            <p className="pipeline-subtitle">总控编排依次调度解析、资格、技术、法规检索、生成与一致性检查，关键节点由人工闸门确认。</p>
          </div>
          <div className="pipeline-header-tags">
            <span
              className={`pipeline-orchestrator${state?.orchestrator === 'langgraph' ? ' is-langgraph' : ''}`}
              title={
                state?.orchestrator === 'langgraph'
                  ? `Python 图编排已生效${state.runId ? `（运行 ${state.runId}）` : ''}`
                  : '未检测到 LangGraph sidecar 或 Python 虚拟环境，当前使用内置编排器；图编排相关能力未启用。'
              }
            >
              {state?.orchestrator === 'langgraph' ? 'LangGraph 编排' : '内置编排'}
            </span>
            {state?.mode === 'review' ? (
              <span className="pipeline-orchestrator is-langgraph" title="人工上传标书复审：跳过解析与生成，只跑一致性检查">
                人工复审
              </span>
            ) : null}
            <span className={`pipeline-status pipeline-status-${pipelineStatus}`}>
              {PIPELINE_STATUS_LABELS[pipelineStatus] ?? pipelineStatus}
            </span>
          </div>
        </header>

        <section className="panel pipeline-control">
          <label className="pipeline-control-label" htmlFor="pipeline-overview">项目概述（可选，供各阶段 Agent 参考）</label>
          <textarea
            id="pipeline-overview"
            className="pipeline-control-input"
            value={overview}
            placeholder="填写项目名称、采购内容、工期或其他背景信息"
            onChange={(event) => setOverview(event.target.value)}
          />
          <label className="pipeline-control-label" htmlFor="pipeline-company">公司资质与已有材料概况（可选，供资格审查参考）</label>
          <textarea
            id="pipeline-company"
            className="pipeline-control-input"
            value={companyProfile}
            placeholder="填写本公司已有资质、业绩、人员、证书等可用于资格匹配的材料"
            onChange={(event) => setCompanyProfile(event.target.value)}
          />
          <div className="pipeline-control-tender">
            <button type="button" className="secondary-action" disabled={importing || pipelineActive} onClick={handleImportTender}>
              {importing ? <InlineSpinner /> : null}
              上传招标文件（Word / PDF / TXT）
            </button>
            {tenderInfo?.fileName ? (
              <span className="pipeline-tender-hint">已解析：{tenderInfo.fileName}（{tenderInfo.chars ? `${tenderInfo.chars} 字符` : ''}{tenderInfo.parserLabel ? ` · ${tenderInfo.parserLabel}` : ''}）</span>
            ) : (
              <span className="pipeline-tender-hint">未上传招标文件时，解析阶段将仅依据上方概述文本。</span>
            )}
          </div>
          <div className="pipeline-control-actions">
            <button type="button" className="primary-action" disabled={starting || pipelineActive} onClick={handleStart}>
              {starting ? <InlineSpinner /> : null}
              启动流水线
            </button>
            <button
              type="button"
              className="secondary-action"
              disabled={exporting || pipelineActive || !canExport}
              onClick={handleExportDraft}
            >
              {exporting ? <InlineSpinner /> : null}
              导出投标文档（Word）
            </button>
            {pipelineActive ? <span className="pipeline-active-hint">流水线执行中，请等待阶段结果或闸门确认</span> : null}
            {!pipelineActive && generateStage?.status === 'success' && !exportReady ? (
              <span className="pipeline-qc-warning">终审未签发：请先在「终审签发」闸门通过，导出 Word 才会解锁。</span>
            ) : null}
            {canExport && passed === false ? (
              <span className="pipeline-qc-warning">
                质检未通过{openHighIssues ? `（${openHighIssues} 项 high）` : ''}，导出的 Word 仅作草稿，请人工复核后再投标。
              </span>
            ) : null}
          </div>
        </section>

        <section className="panel pipeline-control pipeline-review">
          <header className="pipeline-review-head">
            <h3>辅线：人工上传标书复审</h3>
            <p>已有写好的标书？上传或粘贴正文即可，跳过解析与生成，直接跑一致性检查并输出比对报告。</p>
          </header>
          <div className="pipeline-control-tender">
            <button
              type="button"
              className="secondary-action"
              disabled={pickingReview || pipelineActive}
              onClick={handlePickReviewDraft}
            >
              {pickingReview ? <InlineSpinner /> : null}
              选择标书文件（Word / PDF / TXT）
            </button>
            {reviewInfo?.fileName ? (
              <span className="pipeline-tender-hint">
                已读取：{reviewInfo.fileName}（{reviewInfo.chars ? `${reviewInfo.chars} 字符` : ''}
                {reviewInfo.parserLabel ? ` · ${reviewInfo.parserLabel}` : ''}）
              </span>
            ) : (
              <span className="pipeline-tender-hint">也可以直接在下方粘贴正文，或修改上传后的文本再提交。</span>
            )}
          </div>
          <label className="pipeline-control-label" htmlFor="pipeline-review-text">待复审标书正文</label>
          <textarea
            id="pipeline-review-text"
            className="pipeline-control-input pipeline-review-text"
            value={reviewText}
            placeholder="粘贴或上传需要复核的投标文件正文，提交后只触发一致性检查 Agent"
            onChange={(event) => setReviewText(event.target.value)}
          />
          <div className="pipeline-control-actions">
            <button
              type="button"
              className="primary-action"
              disabled={submittingReview || pipelineActive || reviewChars === 0}
              onClick={handleSubmitReview}
            >
              {submittingReview ? <InlineSpinner /> : null}
              提交复审（只跑一致性检查）
            </button>
            <span className="pipeline-tender-hint">
              {reviewChars > 0 ? `当前正文 ${reviewChars} 字符` : '尚未提供正文'}
            </span>
          </div>
        </section>

        {stages.length > 0 ? (
          <section className="pipeline-metrics">
            <div className="pipeline-metric">
              <span className="pipeline-metric-label">阶段通过率</span>
              <span className="pipeline-metric-value">{passRate === null ? '—' : `${passRate}%`}</span>
              <span className="pipeline-metric-sub">
                {successCount}/{countedStages.length} 阶段通过
                {skippedCount ? ` · ${skippedCount} 阶段跳过` : ''}
              </span>
            </div>
            <div className="pipeline-metric">
              <span className="pipeline-metric-label">一致性评分</span>
              <span className="pipeline-metric-value">{score === null ? '—' : score}</span>
              <span className="pipeline-metric-sub">
                {passed === null ? '待质检' : passed ? '质检通过' : openHighIssues ? `未通过（${openHighIssues} 项 high）` : '未通过'}
              </span>
            </div>
            <div className="pipeline-metric">
              <span className="pipeline-metric-label">自动返工轮次</span>
              <span className="pipeline-metric-value">{reworkRounds === null ? '0' : reworkRounds}</span>
              <span className="pipeline-metric-sub">
                {reworkRounds ? (scoreDelta ? `质检分 ${scoreDelta}` : '质检不通过自动回退整改') : '质检通过，未触发返工'}
              </span>
            </div>
          </section>
        ) : null}

        <section className="pipeline-team">
          <header className="pipeline-team-title">
            <h3>Agent 团队契约</h3>
            <p>各 Agent 的工具集、输入输出与上游依赖；技术分析与法规检索并行执行。</p>
          </header>
          <div className="pipeline-team-grid">
            {TEAM_CONTRACTS.map((contract) => (
              <TeamCard key={contract.agentId} contract={contract} />
            ))}
          </div>
        </section>

        <section className="pipeline-team pipeline-schema">
          <header className="pipeline-team-title">
            <h3>节点输出契约（JSON）</h3>
            <p>每个节点产物的字段结构；前端据此渲染真实数据，也方便用假数据先画 UI。</p>
          </header>
          <div className="pipeline-control-actions">
            <button type="button" className="secondary-action" disabled={schemaLoading} onClick={handleLoadSchema}>
              {schemaLoading ? <InlineSpinner /> : null}
              获取节点输出结构
            </button>
            {schema?.notes?.length ? <span className="pipeline-tender-hint">{schema.notes.join('；')}</span> : null}
            {schema && !schema.success ? <span className="pipeline-qc-warning">{schema.message || '节点输出结构不可用'}</span> : null}
          </div>
          {schema?.nodes ? (
            <div className="pipeline-schema-grid">
              {Object.entries(schema.nodes).map(([key, spec]) => (
                <details key={key} className="pipeline-stage-outputs">
                  <summary>
                    {spec.label}（{key} · Agent {spec.agent_id}）
                  </summary>
                  <p className="pipeline-stage-summary">{spec.description}</p>
                  <pre>{JSON.stringify(spec.schema, null, 2)}</pre>
                  <pre>{JSON.stringify(spec.example, null, 2)}</pre>
                </details>
              ))}
            </div>
          ) : null}
        </section>

        {isEmpty ? (
          <EmptyState title="尚未启动流水线" hint="填写项目概述后点击“启动流水线”，各阶段产物将展示在这里。" />
        ) : (
          <div className="pipeline-stages">
            {stages.map((stage, index) => (
              <StageCard
                key={stage.stage_key}
                index={index}
                stage={stage}
                note={notes[stage.stage_key] ?? ''}
                busy={busyStageKey === stage.stage_key}
                onNoteChange={(stageKey, value) => setNotes((prev) => ({ ...prev, [stageKey]: value }))}
                onApprove={(stageKey) => void runApproval(stageKey, 'approve')}
                onReject={(stageKey) => void runApproval(stageKey, 'reject')}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
