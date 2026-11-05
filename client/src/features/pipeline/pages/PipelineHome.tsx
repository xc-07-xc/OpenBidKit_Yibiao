import { useEffect, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { EmptyState, InlineSpinner, useToast } from '../../../shared/ui';
import type { PipelineStage, PipelineState } from '../../../shared/types/ipc';
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
  const recentLogs = stage.logs.slice(-3);
  const outputsJson = formatOutputsJson(stage.outputs);

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
              通过并进入下一阶段
            </button>
            <button type="button" className="danger-action" disabled={busy} onClick={() => onReject(stage.stage_key)}>
              打回重跑本阶段
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TeamCard({ contract }: { contract: TeamContract }) {
  return (
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

  const stages = state?.stages ?? [];
  const pipelineActive = state?.active ?? false;
  const pipelineStatus = state?.status ?? 'idle';
  const isEmpty = stages.length === 0;

  const generateStage = stages.find((item) => item.stage_key === 'generate');
  const canExport = generateStage?.status === 'success';
  const consistency = stages.find((item) => item.stage_key === 'consistency');
  const consistencyOut = consistency ? readStageOutputs(consistency) : {};
  const successCount = stages.filter((item) => item.status === 'success').length;
  const passRate = stages.length ? Math.round((successCount / stages.length) * 100) : null;
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
            {canExport && passed === false ? (
              <span className="pipeline-qc-warning">
                质检未通过{openHighIssues ? `（${openHighIssues} 项 high）` : ''}，导出的 Word 仅作草稿，请人工复核后再投标。
              </span>
            ) : null}
          </div>
        </section>

        {stages.length > 0 ? (
          <section className="pipeline-metrics">
            <div className="pipeline-metric">
              <span className="pipeline-metric-label">阶段通过率</span>
              <span className="pipeline-metric-value">{passRate === null ? '—' : `${passRate}%`}</span>
              <span className="pipeline-metric-sub">{successCount}/{stages.length} 阶段通过</span>
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
