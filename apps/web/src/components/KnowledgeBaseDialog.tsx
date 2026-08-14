import {
  AlertCircle,
  BookOpen,
  Bot,
  Check,
  Download,
  FileText,
  FolderPlus,
  LibraryBig,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type {
  AiCapabilities,
  Attachment,
  KnowledgeAnswer,
  KnowledgeBase,
  KnowledgeBaseMember,
  KnowledgeBaseMemberDirectory,
  KnowledgeBaseMemberRole,
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeSource,
  UserAiModels,
} from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes } from "../utils/format";
import { Avatar } from "./Avatar";

interface KnowledgeBaseDialogProps {
  capabilities: AiCapabilities;
  onClose: () => void;
}

type QueryMode = "SEARCH" | "ASK";

const MAX_FILE_BYTES = 500 * 1024 * 1024;
const ACCEPTED_DOCUMENTS = ".pdf,.docx,.md,.mdx,.txt,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml";

const documentStatus = {
  QUEUED: { label: "等待索引", tone: "pending" },
  INDEXING: { label: "正在理解", tone: "working" },
  READY: { label: "可检索", tone: "ready" },
  FAILED: { label: "索引失败", tone: "failed" },
} as const;

const accessLabel = {
  OWNER: "我创建的",
  EDITOR: "共享 · 可编辑",
  VIEWER: "共享 · 只读",
} as const;

function KnowledgeSourceCard({ source, onOpen }: { source: KnowledgeSource; onOpen: () => void }) {
  return (
    <article className="knowledge-source-card">
      <header>
        <span>
          <FileText size={15} />
          <strong>{source.document.name}</strong>
        </span>
        <small>{Math.round(source.score * 100)}% 相关</small>
      </header>
      <p>{source.excerpt}</p>
      <footer>
        <span>片段 {source.position + 1}</span>
        <button type="button" onClick={onOpen}>
          <Download size={14} />
          打开原文件
        </button>
      </footer>
    </article>
  );
}

/**
 * NearChat 原生知识库工作台。文件仍走现有上传与权限链路，界面只编排知识库、
 * 异步索引和带来源检索，不引入第二套账号或外部知识库控制台。
 */
export function KnowledgeBaseDialog({ capabilities, onClose }: KnowledgeBaseDialogProps) {
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loadingBases, setLoadingBases] = useState(true);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingBase, setSavingBase] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [confirmingBaseDelete, setConfirmingBaseDelete] = useState(false);
  const [confirmingDocumentDeleteId, setConfirmingDocumentDeleteId] = useState<string | null>(null);
  const [showSharing, setShowSharing] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const [memberDirectory, setMemberDirectory] = useState<KnowledgeBaseMemberDirectory | null>(null);
  const [draftMembers, setDraftMembers] = useState<KnowledgeBaseMember[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [queryMode, setQueryMode] = useState<QueryMode>("SEARCH");
  const [queryText, setQueryText] = useState("");
  const [querying, setQuerying] = useState(false);
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [userModels, setUserModels] = useState<UserAiModels>({
    models: [],
    selectedModelId: null,
    defaultModelId: null,
  });
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedBase = useMemo(
    () => bases.find((base) => base.id === selectedId) ?? null,
    [bases, selectedId],
  );
  const selectedUserModel = useMemo(
    () => userModels.models.find((model) => model.id === userModels.selectedModelId) ?? null,
    [userModels],
  );
  const hasPendingDocuments = documents.some(
    (document) => document.status === "QUEUED" || document.status === "INDEXING",
  );
  const canEditDocuments = selectedBase?.accessRole !== "VIEWER";
  const canManageBase = selectedBase?.accessRole === "OWNER";
  const availableCandidates =
    memberDirectory?.candidates.filter(
      (candidate) => !draftMembers.some((member) => member.user.id === candidate.id),
    ) ?? [];

  const loadBases = useCallback(async () => {
    const result = await api.knowledgeBases();
    setBases(result.knowledgeBases);
    setSelectedId((current) =>
      current && result.knowledgeBases.some((base) => base.id === current)
        ? current
        : (result.knowledgeBases[0]?.id ?? null),
    );
  }, []);

  const loadDocuments = useCallback(async (knowledgeBaseId: string, quiet = false) => {
    if (!quiet) setLoadingDocuments(true);
    try {
      const result = await api.knowledgeDocuments(knowledgeBaseId);
      setDocuments(result.documents);
    } finally {
      if (!quiet) setLoadingDocuments(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadBases()
      .catch((error) => {
        if (active) setNotice({ tone: "error", text: errorMessage(error, "知识库加载失败") });
      })
      .finally(() => {
        if (active) setLoadingBases(false);
      });
    return () => {
      active = false;
    };
  }, [loadBases]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showSharing) setShowSharing(false);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, showSharing]);

  useEffect(() => {
    let active = true;
    if (!capabilities.features.knowledgeAnswer) return;
    void api
      .aiModels()
      .then((result) => {
        if (active) setUserModels(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [capabilities.features.knowledgeAnswer]);

  useEffect(() => {
    setDocuments([]);
    setSearchResult(null);
    setAnswer(null);
    setQueryText("");
    setEditing(false);
    setConfirmingBaseDelete(false);
    setConfirmingDocumentDeleteId(null);
    setShowSharing(false);
    setMemberDirectory(null);
    setDraftMembers([]);
    setCandidateId("");
    if (!selectedId) return;
    void loadDocuments(selectedId).catch((error) =>
      setNotice({ tone: "error", text: errorMessage(error, "知识文档加载失败") }),
    );
  }, [loadDocuments, selectedId]);

  useEffect(() => {
    if (!selectedId || !hasPendingDocuments) return;
    const timer = window.setInterval(() => {
      void Promise.all([loadDocuments(selectedId, true), loadBases()]).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasPendingDocuments, loadBases, loadDocuments, selectedId]);

  useEffect(() => {
    if (!selectedBase) return;
    setEditName(selectedBase.name);
    setEditDescription(selectedBase.description);
  }, [selectedBase]);

  const createBase = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    setNotice(null);
    try {
      const result = await api.createKnowledgeBase({
        name: newName.trim(),
        description: newDescription.trim(),
      });
      setBases((current) => [result.knowledgeBase, ...current]);
      setSelectedId(result.knowledgeBase.id);
      setNewName("");
      setNewDescription("");
      setShowCreate(false);
      setNotice({ tone: "success", text: "知识库已创建" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "知识库创建失败") });
    } finally {
      setCreating(false);
    }
  };

  const saveBase = async () => {
    if (!selectedBase || !editName.trim() || savingBase) return;
    setSavingBase(true);
    try {
      const result = await api.updateKnowledgeBase(selectedBase.id, {
        name: editName.trim(),
        description: editDescription.trim(),
      });
      setBases((current) =>
        current.map((base) => (base.id === result.knowledgeBase.id ? result.knowledgeBase : base)),
      );
      setEditing(false);
      setNotice({ tone: "success", text: "知识库信息已保存" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "保存失败") });
    } finally {
      setSavingBase(false);
    }
  };

  const removeBase = async () => {
    if (!selectedBase) return;
    try {
      await api.deleteKnowledgeBase(selectedBase.id);
      const remaining = bases.filter((base) => base.id !== selectedBase.id);
      setBases(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setNotice({ tone: "success", text: "知识库已删除" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "知识库删除失败") });
    } finally {
      setConfirmingBaseDelete(false);
    }
  };

  const openSharing = async () => {
    if (!selectedBase || selectedBase.accessRole !== "OWNER") return;
    setShowSharing(true);
    setLoadingMembers(true);
    setCandidateId("");
    try {
      const directory = await api.knowledgeBaseMembers(selectedBase.id);
      setMemberDirectory(directory);
      setDraftMembers(directory.members);
    } catch (error) {
      setShowSharing(false);
      setNotice({ tone: "error", text: errorMessage(error, "共享成员加载失败") });
    } finally {
      setLoadingMembers(false);
    }
  };

  const addDraftMember = () => {
    const user = availableCandidates.find((candidate) => candidate.id === candidateId);
    if (!user) return;
    setDraftMembers((current) => [
      ...current,
      { user, role: "VIEWER", addedAt: new Date().toISOString() },
    ]);
    setCandidateId("");
  };

  const updateDraftMemberRole = (userId: string, role: KnowledgeBaseMemberRole) => {
    setDraftMembers((current) =>
      current.map((member) => (member.user.id === userId ? { ...member, role } : member)),
    );
  };

  const saveSharedMembers = async () => {
    if (!selectedBase || savingMembers) return;
    setSavingMembers(true);
    try {
      const directory = await api.updateKnowledgeBaseMembers(
        selectedBase.id,
        draftMembers.map((member) => ({ userId: member.user.id, role: member.role })),
      );
      setMemberDirectory(directory);
      setDraftMembers(directory.members);
      await loadBases();
      setShowSharing(false);
      setNotice({ tone: "success", text: "共享权限已更新" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "共享权限保存失败") });
    } finally {
      setSavingMembers(false);
    }
  };

  const addDocument = async (file?: File) => {
    if (!file || !selectedBase || !canEditDocuments || uploading) return;
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ tone: "error", text: "知识文档不能超过 500 MB" });
      return;
    }
    setUploading({ name: file.name, progress: 0 });
    setNotice(null);
    let attachment: Attachment | null = null;
    try {
      attachment = await api.upload(file, (progress) =>
        setUploading({ name: file.name, progress }),
      );
      await api.addKnowledgeDocument(selectedBase.id, attachment.id);
      await Promise.all([loadDocuments(selectedBase.id), loadBases()]);
      setNotice({ tone: "success", text: "文档已加入，正在后台建立索引" });
    } catch (error) {
      if (attachment) await api.deleteFile(attachment.id).catch(() => undefined);
      setNotice({ tone: "error", text: errorMessage(error, "文档添加失败") });
    } finally {
      setUploading(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const reindexDocument = async (document: KnowledgeDocument) => {
    if (!selectedBase || !canEditDocuments || busyDocumentId) return;
    setBusyDocumentId(document.id);
    try {
      await api.reindexKnowledgeDocument(selectedBase.id, document.id);
      await loadDocuments(selectedBase.id);
      setNotice({ tone: "success", text: "已重新加入索引队列" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "重新索引失败") });
    } finally {
      setBusyDocumentId(null);
    }
  };

  const removeDocument = async (document: KnowledgeDocument) => {
    if (!selectedBase || !canEditDocuments || busyDocumentId) return;
    setBusyDocumentId(document.id);
    try {
      await api.deleteKnowledgeDocument(selectedBase.id, document.id);
      await Promise.all([loadDocuments(selectedBase.id), loadBases()]);
      setNotice({ tone: "success", text: "文档已移除" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "文档移除失败") });
    } finally {
      setBusyDocumentId(null);
      setConfirmingDocumentDeleteId(null);
    }
  };

  const runQuery = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedBase || !queryText.trim() || querying) return;
    setQuerying(true);
    setNotice(null);
    try {
      if (queryMode === "ASK") {
        const result = await api.askKnowledge(
          selectedBase.id,
          queryText.trim(),
          userModels.selectedModelId ?? undefined,
        );
        setAnswer(result);
        setSearchResult(null);
      } else {
        const result = await api.searchKnowledge(selectedBase.id, queryText.trim());
        setSearchResult(result);
        setAnswer(null);
      }
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "知识库查询失败") });
    } finally {
      setQuerying(false);
    }
  };

  const openAttachment = async (attachment: Attachment) => {
    try {
      const blob = await api.fileBlob(attachment.id);
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        const link = document.createElement("a");
        link.href = url;
        link.download = attachment.originalName;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "原文件打开失败") });
    }
  };

  const sources = answer?.sources ?? searchResult?.sources ?? [];

  return createPortal(
    <div
      className="knowledge-layer"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="knowledge-dialog" role="dialog" aria-modal="true" aria-label="团队知识库">
        <header className="knowledge-dialog-header">
          <div>
            <span className="knowledge-brand-icon">
              <LibraryBig size={21} />
            </span>
            <span>
              <strong>团队知识库</strong>
              <small>按成员共享资料，检索结果始终附带来源</small>
            </span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭知识库">
            <X size={19} />
          </button>
        </header>

        <div className={`knowledge-capability is-${capabilities.status.toLowerCase()}`}>
          {capabilities.status === "READY" ? <Sparkles size={15} /> : <AlertCircle size={15} />}
          <span>{capabilities.reason}</span>
          {capabilities.provider.embeddingModel && (
            <code>{capabilities.provider.embeddingModel}</code>
          )}
        </div>

        {notice && (
          <div
            className={`knowledge-notice is-${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.tone === "success" ? <Check size={15} /> : <AlertCircle size={15} />}
            {notice.text}
          </div>
        )}

        {showSharing && selectedBase && (
          <div
            className="knowledge-share-layer"
            role="presentation"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setShowSharing(false);
            }}
          >
            <aside className="knowledge-share-panel" role="dialog" aria-label="知识库共享设置">
              <header>
                <span>
                  <UsersRound size={19} />
                </span>
                <div>
                  <strong>共享“{selectedBase.name}”</strong>
                  <small>编辑者可以维护文档，查看者只能检索和问答</small>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowSharing(false)}
                  aria-label="关闭共享设置"
                >
                  <X size={17} />
                </button>
              </header>

              {loadingMembers ? (
                <div className="knowledge-share-loading">
                  <LoaderCircle size={20} className="spin" />
                  正在读取团队成员
                </div>
              ) : memberDirectory ? (
                <>
                  <div className="knowledge-share-owner">
                    <Avatar
                      name={memberDirectory.owner.displayName}
                      color={memberDirectory.owner.avatarColor}
                      src={memberDirectory.owner.avatarUrl}
                      size="small"
                    />
                    <span>
                      <strong>{memberDirectory.owner.displayName}</strong>
                      <small>@{memberDirectory.owner.username}</small>
                    </span>
                    <em>拥有者</em>
                  </div>

                  <div className="knowledge-share-add">
                    <select
                      aria-label="选择共享成员"
                      value={candidateId}
                      onChange={(event) => setCandidateId(event.target.value)}
                      disabled={availableCandidates.length === 0}
                    >
                      <option value="">
                        {availableCandidates.length > 0 ? "选择团队成员…" : "没有可添加的成员"}
                      </option>
                      {availableCandidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.displayName} · @{candidate.username}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={addDraftMember} disabled={!candidateId}>
                      <UserPlus size={14} />
                      添加
                    </button>
                  </div>

                  <div className="knowledge-share-members">
                    <div className="knowledge-share-caption">
                      <span>已共享成员</span>
                      <small>{draftMembers.length} 人</small>
                    </div>
                    {draftMembers.length === 0 ? (
                      <div className="knowledge-share-empty">
                        <UsersRound size={23} />
                        <span>尚未共享给其他成员</span>
                      </div>
                    ) : (
                      draftMembers.map((member) => (
                        <div className="knowledge-share-member" key={member.user.id}>
                          <Avatar
                            name={member.user.displayName}
                            color={member.user.avatarColor}
                            src={member.user.avatarUrl}
                            size="small"
                          />
                          <span>
                            <strong>{member.user.displayName}</strong>
                            <small>@{member.user.username}</small>
                          </span>
                          <select
                            aria-label={`设置 ${member.user.displayName} 的权限`}
                            value={member.role}
                            onChange={(event) =>
                              updateDraftMemberRole(
                                member.user.id,
                                event.target.value as KnowledgeBaseMemberRole,
                              )
                            }
                          >
                            <option value="VIEWER">查看者</option>
                            <option value="EDITOR">编辑者</option>
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              setDraftMembers((current) =>
                                current.filter((item) => item.user.id !== member.user.id),
                              )
                            }
                            aria-label={`移除 ${member.user.displayName}`}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <footer>
                    <span>撤销共享后，对方助理中的对应知识库绑定也会自动解除。</span>
                    <div>
                      <button type="button" onClick={() => setShowSharing(false)}>
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveSharedMembers()}
                        disabled={savingMembers}
                      >
                        {savingMembers && <LoaderCircle size={13} className="spin" />}
                        保存权限
                      </button>
                    </div>
                  </footer>
                </>
              ) : null}
            </aside>
          </div>
        )}

        <div className="knowledge-workspace">
          <aside className="knowledge-base-list">
            <div className="knowledge-section-title">
              <span>知识空间</span>
              <button
                type="button"
                onClick={() => setShowCreate((current) => !current)}
                aria-label="新建知识库"
              >
                <Plus size={16} />
              </button>
            </div>
            {showCreate && (
              <form className="knowledge-create-form" onSubmit={createBase}>
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="例如：产品资料"
                  maxLength={80}
                  autoFocus
                />
                <textarea
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  placeholder="一句话说明（可选）"
                  maxLength={240}
                  rows={2}
                />
                <div>
                  <button type="button" onClick={() => setShowCreate(false)}>
                    取消
                  </button>
                  <button type="submit" disabled={creating || !newName.trim()}>
                    {creating && <LoaderCircle size={13} className="spin" />}
                    创建
                  </button>
                </div>
              </form>
            )}
            <div className="knowledge-base-scroll">
              {loadingBases ? (
                <div className="knowledge-list-loading">
                  <LoaderCircle className="spin" size={18} />
                  正在加载
                </div>
              ) : bases.length === 0 ? (
                <button
                  className="knowledge-empty-create"
                  type="button"
                  onClick={() => setShowCreate(true)}
                >
                  <FolderPlus size={23} />
                  <strong>创建第一个知识库</strong>
                  <small>按项目或主题整理团队资料</small>
                </button>
              ) : (
                bases.map((base) => (
                  <button
                    className={`knowledge-base-item ${base.id === selectedId ? "is-active" : ""}`}
                    type="button"
                    key={base.id}
                    onClick={() => setSelectedId(base.id)}
                  >
                    <span>
                      <BookOpen size={16} />
                    </span>
                    <span>
                      <strong>{base.name}</strong>
                      <small>
                        {base.readyDocumentCount}/{base.documentCount} 份资料就绪
                      </small>
                      <i className={`knowledge-access-tag is-${base.accessRole.toLowerCase()}`}>
                        {accessLabel[base.accessRole]}
                      </i>
                    </span>
                  </button>
                ))
              )}
            </div>
            <footer>
              <span>精确到成员的访问权限</span>
              <small>拥有者、编辑者与查看者各司其职</small>
            </footer>
          </aside>

          <section className="knowledge-document-panel">
            {selectedBase ? (
              <>
                <header className="knowledge-base-header">
                  {editing ? (
                    <div className="knowledge-base-editor">
                      <input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        maxLength={80}
                      />
                      <textarea
                        value={editDescription}
                        onChange={(event) => setEditDescription(event.target.value)}
                        rows={2}
                        maxLength={240}
                      />
                      <div>
                        <button type="button" onClick={() => setEditing(false)}>
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveBase()}
                          disabled={savingBase || !editName.trim()}
                        >
                          {savingBase && <LoaderCircle size={13} className="spin" />}保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <span>
                        <strong>{selectedBase.name}</strong>
                        <small>{selectedBase.description || "尚未添加说明"}</small>
                        <em className="knowledge-base-owner">
                          {selectedBase.accessRole === "OWNER"
                            ? `由你管理 · ${selectedBase.memberCount} 位成员`
                            : `${selectedBase.owner.displayName} 创建 · ${accessLabel[selectedBase.accessRole]}`}
                        </em>
                      </span>
                      {canManageBase && (
                        <span
                          className={`knowledge-base-actions ${confirmingBaseDelete ? "is-confirming" : ""}`}
                        >
                          {confirmingBaseDelete ? (
                            <>
                              <small>确认删除？</small>
                              <button
                                type="button"
                                onClick={() => setConfirmingBaseDelete(false)}
                                aria-label="取消删除知识库"
                              >
                                <X size={14} />
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => void removeBase()}
                                aria-label="确认删除知识库"
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => void openSharing()}
                                title="共享设置"
                                aria-label="共享设置"
                              >
                                <Share2 size={15} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditing(true)}
                                title="编辑知识库"
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => setConfirmingBaseDelete(true)}
                                title="删除知识库"
                              >
                                <Trash2 size={15} />
                              </button>
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </header>

                <div className="knowledge-upload-row">
                  <div>
                    <strong>知识文档</strong>
                    <small>
                      {canEditDocuments
                        ? "PDF、DOCX、Markdown、JSON 与文本 · 最大 500 MB"
                        : "你拥有查看权限，可以检索、问答和打开来源文件"}
                    </small>
                  </div>
                  {canEditDocuments ? (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={ACCEPTED_DOCUMENTS}
                        hidden
                        onChange={(event) => void addDocument(event.target.files?.[0])}
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={Boolean(uploading)}
                      >
                        {uploading ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <Upload size={15} />
                        )}
                        {uploading ? `${uploading.progress}%` : "添加文档"}
                      </button>
                    </>
                  ) : (
                    <span className="knowledge-readonly-badge">只读</span>
                  )}
                </div>
                {uploading && (
                  <div className="knowledge-upload-progress">
                    <span>
                      <i style={{ width: `${uploading.progress}%` }} />
                    </span>
                    <small>{uploading.name}</small>
                  </div>
                )}

                <div className="knowledge-document-list">
                  {loadingDocuments ? (
                    <div className="knowledge-document-empty">
                      <LoaderCircle size={21} className="spin" />
                      正在读取文档
                    </div>
                  ) : documents.length === 0 ? (
                    <div className="knowledge-document-empty">
                      <FileText size={28} />
                      <strong>还没有知识文档</strong>
                      <span>添加团队手册、项目说明或常用资料</span>
                    </div>
                  ) : (
                    documents.map((document) => {
                      const status = documentStatus[document.status];
                      const busy = busyDocumentId === document.id;
                      return (
                        <article className="knowledge-document-item" key={document.id}>
                          <span className="knowledge-file-icon">
                            <FileText size={18} />
                          </span>
                          <span className="knowledge-file-copy">
                            <strong title={document.attachment.originalName}>
                              {document.attachment.originalName}
                            </strong>
                            <small>
                              {formatBytes(document.attachment.sizeBytes)}
                              {document.chunkCount > 0 ? ` · ${document.chunkCount} 个片段` : ""}
                            </small>
                            {document.errorMessage && (
                              <em title={document.errorMessage}>{document.errorMessage}</em>
                            )}
                          </span>
                          <span className={`knowledge-status is-${status.tone}`}>
                            {(document.status === "QUEUED" || document.status === "INDEXING") && (
                              <LoaderCircle size={12} className="spin" />
                            )}
                            {status.label}
                          </span>
                          {canEditDocuments && (
                            <span
                              className={`knowledge-document-actions ${confirmingDocumentDeleteId === document.id ? "is-confirming" : ""}`}
                            >
                              {confirmingDocumentDeleteId === document.id ? (
                                <>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setConfirmingDocumentDeleteId(null)}
                                    aria-label={`取消移除 ${document.attachment.originalName}`}
                                  >
                                    <X size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    className="danger"
                                    disabled={busy}
                                    onClick={() => void removeDocument(document)}
                                    aria-label={`确认移除 ${document.attachment.originalName}`}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </>
                              ) : (
                                <>
                                  {(document.status === "FAILED" ||
                                    document.status === "READY") && (
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void reindexDocument(document)}
                                      title="重新索引"
                                    >
                                      <RefreshCw size={14} />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setConfirmingDocumentDeleteId(document.id)}
                                    title="移除文档"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </>
                              )}
                            </span>
                          )}
                        </article>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <div className="knowledge-panel-empty">
                <LibraryBig size={35} />
                <strong>选择或创建一个知识库</strong>
              </div>
            )}
          </section>

          <section className="knowledge-query-panel">
            <header>
              <div className="knowledge-query-tabs">
                <button
                  type="button"
                  className={queryMode === "SEARCH" ? "is-active" : ""}
                  onClick={() => setQueryMode("SEARCH")}
                >
                  <Search size={15} />
                  检索
                </button>
                <button
                  type="button"
                  className={queryMode === "ASK" ? "is-active" : ""}
                  onClick={() => setQueryMode("ASK")}
                >
                  <Bot size={15} />
                  问答
                </button>
              </div>
              <small>
                {queryMode === "ASK" && userModels.models.length > 0 ? (
                  <label className="knowledge-model-select">
                    <Bot size={13} />
                    <select
                      aria-label="选择问答模型"
                      value={userModels.selectedModelId ?? ""}
                      onChange={(event) => {
                        const modelId = event.target.value;
                        const previousModelId = userModels.selectedModelId;
                        setUserModels((current) => ({ ...current, selectedModelId: modelId }));
                        void api
                          .selectAiModel(modelId)
                          .then(setUserModels)
                          .catch((error) => {
                            setUserModels((current) => ({
                              ...current,
                              selectedModelId: previousModelId,
                            }));
                            setNotice({
                              tone: "error",
                              text: errorMessage(error, "模型切换失败"),
                            });
                          });
                      }}
                    >
                      {userModels.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                          {model.isDefault ? " · 默认" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : searchResult?.mode === "KEYWORD" || !capabilities.features.knowledgeSearch ? (
                  "本地关键词"
                ) : (
                  "语义 + 关键词"
                )}
              </small>
            </header>
            <form className="knowledge-query-form" onSubmit={runQuery}>
              <textarea
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder={queryMode === "ASK" ? "基于知识库提一个问题…" : "查找文档中的内容…"}
                rows={3}
                maxLength={queryMode === "ASK" ? 2000 : 1000}
                disabled={!selectedBase}
              />
              <button
                type="submit"
                disabled={
                  !selectedBase ||
                  !queryText.trim() ||
                  querying ||
                  (queryMode === "ASK" && !capabilities.features.knowledgeAnswer)
                }
              >
                {querying ? (
                  <LoaderCircle size={15} className="spin" />
                ) : queryMode === "ASK" ? (
                  <Sparkles size={15} />
                ) : (
                  <Search size={15} />
                )}
                {queryMode === "ASK" ? "生成回答" : "开始检索"}
              </button>
            </form>
            {queryMode === "ASK" && !capabilities.features.knowledgeAnswer && (
              <div className="knowledge-query-hint">
                <AlertCircle size={14} />
                配置对话模型后可使用带来源问答；文档检索仍可使用。
              </div>
            )}
            <div className="knowledge-results">
              {answer && (
                <article className="knowledge-answer">
                  <header>
                    <Sparkles size={16} />
                    <strong>
                      知识助理
                      {selectedUserModel ? ` · ${selectedUserModel.name}` : ""}
                    </strong>
                  </header>
                  <p>{answer.answer}</p>
                </article>
              )}
              {sources.length > 0 ? (
                <>
                  <div className="knowledge-results-title">
                    <span>{answer ? "回答依据" : "检索结果"}</span>
                    <small>{sources.length} 个片段</small>
                  </div>
                  {sources.map((source) => (
                    <KnowledgeSourceCard
                      key={source.chunkId}
                      source={source}
                      onOpen={() => void openAttachment(source.document.attachment)}
                    />
                  ))}
                </>
              ) : searchResult || answer ? (
                <div className="knowledge-result-empty">
                  <Search size={22} />
                  没有找到相关资料
                </div>
              ) : (
                <div className="knowledge-result-empty is-idle">
                  <Sparkles size={24} />
                  <strong>答案应该能够被追溯</strong>
                  <span>检索和问答都会标出原文件与具体片段</span>
                </div>
              )}
            </div>
          </section>
        </div>
      </section>
    </div>,
    document.body,
  );
}
