"use client";

import { useState, useRef, useEffect } from "react";
import {
  Send,
  FileText,
  Bot,
  User,
  PanelRightOpen,
  PanelRightClose,
  UploadCloud,
  CheckCircle2,
  Trash2,
  Loader2,
  Eye,
  Edit3,
  X,
  Save,
  Layers,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/bits/fade-in";

const API_BASE = "/api";

export interface RetrievalMatch {
  chunk_id: number;
  content: string;
  filename: string;
  score: number;
  dense_score: number | null;
  dense_rank: number | null;
  bm25_score: number | null;
  bm25_rank: number | null;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceFiles?: string[];
  retrievalMatches?: RetrievalMatch[];
}

interface UploadedDoc {
  id: string;
  name: string;
  size: string;
  status: "ready" | "indexing";
}

interface DocDetail {
  id: string;
  filename: string;
  size: string;
  pre_processed: string;
  post_processed: string;
  chunks: string[];
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "assistant",
      content:
        "PKMS Agent connected. Ingestion pipeline is active: documents are streamed to MinIO, processed via Celery worker with PyMuPDF/Docx text normalization, and indexed with TEI embeddings + PostgreSQL pgvector & tsvector GIN.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [documents, setDocuments] = useState<UploadedDoc[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  // Score threshold filters for retrieval
  const [minDenseScore, setMinDenseScore] = useState<number>(0.0);
  const [minBm25Score, setMinBm25Score] = useState<number>(0.0);

  // Document Inspector / Editor modal state
  const [inspectDoc, setInspectDoc] = useState<DocDetail | null>(null);
  const [selectedRetrievalMessage, setSelectedRetrievalMessage] = useState<Message | null>(null);
  const [activeTab, setActiveTab] = useState<"post" | "pre" | "chunks">("post");
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API_BASE}/documents`);
      if (res.ok) {
        const data = await res.json();
        setDocuments(data);
      }
    } catch (err) {
      console.error("Failed to fetch documents", err);
    }
  };

  useEffect(() => {
    fetchDocuments();
    const interval = setInterval(() => {
      fetchDocuments();
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isSending) return;

    const userText = input.trim();
    setInput("");
    setIsSending(true);

    const newMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: userText,
    };
    setMessages((prev) => [...prev, newMsg]);

    try {
      const res = await fetch(`${API_BASE}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: userText,
          min_dense_score: minDenseScore > 0 ? minDenseScore : undefined,
          min_bm25_score: minBm25Score > 0 ? minBm25Score : undefined,
        }),
      });

      if (!res.ok) throw new Error("Query request failed");

      const data = await res.json();
      const botResponse: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.answer,
        sourceFiles: data.sources,
        retrievalMatches: data.matches,
      };
      setMessages((prev) => [...prev, botResponse]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "Error communicating with PKMS backend gateway.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch(`${API_BASE}/ingest`, {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          const doc = await res.json();
          setDocuments((prev) => [doc, ...prev]);
        }
      } catch (err) {
        console.error("Upload error", err);
      }
    }

    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    // Refresh doc list after Celery finishes
    setTimeout(fetchDocuments, 1500);
  };

  const removeDoc = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`${API_BASE}/documents/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.id !== id));
        if (inspectDoc?.id === id) setInspectDoc(null);
      }
    } catch (err) {
      console.error("Delete error", err);
    }
  };

  const openDocumentInspector = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/documents/${id}`);
      if (res.ok) {
        const data: DocDetail = await res.json();
        setInspectDoc(data);
        setEditContent(data.post_processed || data.pre_processed);
        setIsEditing(false);
        setActiveTab("post");
      }
    } catch (err) {
      console.error("Failed to inspect document", err);
    }
  };

  const handleSaveEdit = async () => {
    if (!inspectDoc) return;
    setIsSaving(true);
    try {
      const res = await fetch(`${API_BASE}/documents/${inspectDoc.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (res.ok) {
        setIsEditing(false);
        await openDocumentInspector(inspectDoc.id);
      }
    } catch (err) {
      console.error("Save error", err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-200 font-mono text-xs selection:bg-neutral-800">
      {/* Main Chat Area */}
      <div className="flex flex-1 flex-col h-full min-w-0">
        <header className="flex h-11 items-center justify-between border-b border-neutral-800 px-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-neutral-400" />
            <span className="font-semibold text-neutral-100">PKMS Agent</span>
            <span className="text-[10px] text-neutral-600 border border-neutral-800 px-1 py-0.5">
              Pipeline Active (MinIO + RabbitMQ + Celery + TEI + pgvector)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="text-[11px] flex items-center gap-1.5"
            >
              {isSidebarOpen ? (
                <>
                  <PanelRightClose className="h-3.5 w-3.5" />
                  <span>HIDE DOCS</span>
                </>
              ) : (
                <>
                  <PanelRightOpen className="h-3.5 w-3.5" />
                  <span>DOCS ({documents.length})</span>
                </>
              )}
            </Button>
          </div>
        </header>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((m) => (
            <FadeIn key={m.id}>
              <div
                className={`flex gap-3 max-w-2xl ${
                  m.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                }`}
              >
                <div
                  className={`h-6 w-6 flex items-center justify-center shrink-0 border ${
                    m.role === "user"
                      ? "border-neutral-700 bg-neutral-900 text-neutral-200"
                      : "border-neutral-800 bg-neutral-900 text-neutral-400"
                  }`}
                >
                  {m.role === "user" ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                </div>

                <div className="flex flex-col gap-1 max-w-[85%]">
                  <div
                    className={`p-3 border leading-relaxed whitespace-pre-wrap ${
                      m.role === "user"
                        ? "border-neutral-700 bg-neutral-900 text-neutral-100"
                        : "border-neutral-800 bg-neutral-950 text-neutral-300"
                    }`}
                  >
                    {m.content}
                  </div>

                  {m.sourceFiles && m.sourceFiles.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[10px] text-neutral-500">
                      <div className="flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        <span>Sources: {m.sourceFiles.join(", ")}</span>
                      </div>
                      {m.retrievalMatches && m.retrievalMatches.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedRetrievalMessage(m)}
                          className="flex items-center gap-1 border border-neutral-800 bg-neutral-900/60 px-2 py-0.5 text-[10px] text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900 hover:text-white transition-colors cursor-pointer"
                        >
                          <Info className="h-3 w-3 text-neutral-400" />
                          <span>RETRIEVAL DETAILS ({m.retrievalMatches.length})</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </FadeIn>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input Bar */}
        <footer className="border-t border-neutral-800 p-3 bg-neutral-950">
          <form onSubmit={handleSend} className="max-w-3xl mx-auto flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Query ingested knowledge base (RRF hybrid search)..."
              className="flex-1 bg-neutral-900/60 border border-neutral-800 px-3 py-2 text-xs text-neutral-100 focus:outline-none focus:border-neutral-700 placeholder:text-neutral-600 font-mono"
            />
            <Button type="submit" disabled={!input.trim() || isSending} className="px-4">
              {isSending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              SEND
            </Button>
          </form>
        </footer>
      </div>

      {/* Right Drawer / Sidebar for Document Management */}
      {isSidebarOpen && (
        <aside className="w-80 border-l border-neutral-800 bg-neutral-950 flex flex-col h-full shrink-0">
          <div className="flex h-11 items-center justify-between border-b border-neutral-800 px-3">
            <div className="flex items-center gap-1.5 font-semibold text-neutral-200 text-xs">
              <FileText className="h-3.5 w-3.5 text-neutral-400" />
              <span>DOCUMENTS</span>
              <span className="text-[10px] text-neutral-600">({documents.length})</span>
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 text-[11px]"
            >
              {isUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UploadCloud className="h-3.5 w-3.5" />
              )}
              <span>{isUploading ? "INGESTING..." : "UPLOAD"}</span>
            </Button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
              multiple
            />
          </div>

          {/* Score Threshold Filters */}
          <div className="border-b border-neutral-800 bg-neutral-900/30 p-3 space-y-2.5">
            <div className="flex items-center justify-between text-[11px] font-semibold text-neutral-300">
              <span>RETRIEVAL FILTERS</span>
              {(minDenseScore > 0 || minBm25Score > 0) && (
                <button
                  type="button"
                  onClick={() => {
                    setMinDenseScore(0);
                    setMinBm25Score(0);
                  }}
                  className="text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  RESET
                </button>
              )}
            </div>

            {/* Dense Threshold Slider */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-neutral-400">Min Dense (TEI):</span>
                <span className="font-bold text-emerald-400 font-mono">
                  {minDenseScore > 0 ? minDenseScore.toFixed(2) : "Off"}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="0.95"
                step="0.05"
                value={minDenseScore}
                onChange={(e) => setMinDenseScore(parseFloat(e.target.value))}
                className="w-full h-1 bg-neutral-800 accent-emerald-500 cursor-pointer"
              />
            </div>

            {/* BM25 Threshold Slider */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-neutral-400">Min BM25 (GIN):</span>
                <span className="font-bold text-sky-400 font-mono">
                  {minBm25Score > 0 ? minBm25Score.toFixed(2) : "Off"}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1.0"
                step="0.05"
                value={minBm25Score}
                onChange={(e) => setMinBm25Score(parseFloat(e.target.value))}
                className="w-full h-1 bg-neutral-800 accent-sky-500 cursor-pointer"
              />
            </div>
          </div>

          {/* Doc List */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {documents.length === 0 ? (
              <div className="text-center text-neutral-600 py-12 text-[11px]">
                No indexed documents yet. Upload a document to start.
              </div>
            ) : (
              documents.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => openDocumentInspector(doc.id)}
                  className="flex items-center justify-between border border-neutral-900 bg-neutral-900/30 p-2 hover:border-neutral-700 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-2 min-w-0 pr-2">
                    {doc.status === "indexing" ? (
                      <Loader2 className="h-3.5 w-3.5 text-amber-400 animate-spin shrink-0" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
                    )}
                    <div className="flex flex-col min-w-0">
                      <span className="truncate text-neutral-200 text-xs group-hover:text-white">
                        {doc.name}
                      </span>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className="text-neutral-600">{doc.size}</span>
                        {doc.status === "indexing" && (
                          <span className="text-amber-400 font-semibold text-[9px] border border-amber-900/50 bg-amber-950/40 px-1 py-0.2">
                            INDEXING...
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-neutral-500 hover:text-neutral-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDocumentInspector(doc.id);
                      }}
                      title="Inspect / Edit"
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-neutral-600 hover:text-red-400"
                      onClick={(e) => removeDoc(doc.id, e)}
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-3 border-t border-neutral-800 text-[10px] text-neutral-600 flex justify-between items-center">
            <span>Storage: MinIO S3</span>
            <span>Index: pgvector HNSW + GIN</span>
          </div>
        </aside>
      )}

      {/* Document Pre/Post Inspector & Editor Modal */}
      {inspectDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-xs">
          <div className="flex h-5/6 w-4/5 max-w-4xl flex-col border border-neutral-800 bg-neutral-950 shadow-2xl">
            {/* Modal Header */}
            <div className="flex h-11 items-center justify-between border-b border-neutral-800 px-4">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-neutral-400" />
                <span className="font-semibold text-neutral-200">{inspectDoc.filename}</span>
                <span className="text-[10px] text-neutral-600">({inspectDoc.size})</span>
              </div>

              <div className="flex items-center gap-2">
                {!isEditing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsEditing(true);
                      setEditContent(inspectDoc.post_processed || inspectDoc.pre_processed);
                    }}
                    className="flex items-center gap-1"
                  >
                    <Edit3 className="h-3 w-3" />
                    <span>EDIT</span>
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    disabled={isSaving}
                    onClick={handleSaveEdit}
                    className="flex items-center gap-1"
                  >
                    {isSaving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    <span>SAVE & RE-INDEX</span>
                  </Button>
                )}

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-neutral-400 hover:text-white"
                  onClick={() => setInspectDoc(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-neutral-800 bg-neutral-900/40 px-4 text-[11px]">
              <button
                onClick={() => {
                  setActiveTab("post");
                  setIsEditing(false);
                }}
                className={`py-2 px-3 border-b-2 font-mono ${
                  activeTab === "post"
                    ? "border-neutral-200 text-neutral-100"
                    : "border-transparent text-neutral-500 hover:text-neutral-300"
                }`}
              >
                POST-PROCESSED (NORMALIZED TEXT)
              </button>
              <button
                onClick={() => {
                  setActiveTab("pre");
                  setIsEditing(false);
                }}
                className={`py-2 px-3 border-b-2 font-mono ${
                  activeTab === "pre"
                    ? "border-neutral-200 text-neutral-100"
                    : "border-transparent text-neutral-500 hover:text-neutral-300"
                }`}
              >
                PRE-PROCESSED (RAW MINIO BLOB)
              </button>
              <button
                onClick={() => {
                  setActiveTab("chunks");
                  setIsEditing(false);
                }}
                className={`py-2 px-3 border-b-2 font-mono flex items-center gap-1 ${
                  activeTab === "chunks"
                    ? "border-neutral-200 text-neutral-100"
                    : "border-transparent text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <Layers className="h-3 w-3" />
                <span>INDEXED CHUNKS ({inspectDoc.chunks.length})</span>
              </button>
            </div>

            {/* Modal Content Body */}
            <div className="flex-1 overflow-y-auto p-4 bg-neutral-950 text-neutral-300 font-mono text-xs">
              {isEditing ? (
                <div className="flex h-full flex-col gap-2">
                  <div className="text-[10px] text-neutral-500">
                    Editing this document will re-chunk and recalculate TEI embeddings and GIN full-text index upon save.
                  </div>
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="flex-1 w-full bg-neutral-900/70 border border-neutral-800 p-3 text-xs font-mono text-neutral-100 focus:outline-none focus:border-neutral-600 resize-none"
                  />
                </div>
              ) : activeTab === "post" ? (
                <pre className="whitespace-pre-wrap leading-relaxed select-text">
                  {inspectDoc.post_processed || "No normalized content available yet."}
                </pre>
              ) : activeTab === "pre" ? (
                <pre className="whitespace-pre-wrap leading-relaxed select-text text-neutral-400">
                  {inspectDoc.pre_processed}
                </pre>
              ) : (
                <div className="space-y-3">
                  {inspectDoc.chunks.map((chunk, idx) => (
                    <div
                      key={idx}
                      className="border border-neutral-800 bg-neutral-900/40 p-3 flex flex-col gap-1"
                    >
                      <span className="text-[10px] text-neutral-600 font-semibold">
                        CHUNK #{idx + 1}
                      </span>
                      <p className="whitespace-pre-wrap text-neutral-300">{chunk}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Retrieval Details Dialog Modal */}
      {selectedRetrievalMessage && selectedRetrievalMessage.retrievalMatches && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-xs">
          <div className="flex h-5/6 w-11/12 max-w-5xl flex-col border border-neutral-800 bg-neutral-950 shadow-2xl">
            {/* Modal Header */}
            <div className="flex h-12 items-center justify-between border-b border-neutral-800 px-4 bg-neutral-900/60">
              <div className="flex items-center gap-2">
                <Info className="h-4 w-4 text-neutral-400" />
                <span className="font-semibold text-neutral-200">
                  RETRIEVAL INSPECTION
                </span>
                <span className="text-[10px] text-neutral-500 border border-neutral-800 px-1.5 py-0.5">
                  {selectedRetrievalMessage.retrievalMatches.length} CHUNKS RETRIEVED (RRF HYBRID)
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-neutral-400 hover:text-white"
                onClick={() => setSelectedRetrievalMessage(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-neutral-950">
              {selectedRetrievalMessage.retrievalMatches.map((match, idx) => (
                <div
                  key={match.chunk_id || idx}
                  className="border border-neutral-800 bg-neutral-900/40 p-4 space-y-3"
                >
                  {/* Top metadata bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800/80 pb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="bg-neutral-800 text-neutral-200 px-1.5 py-0.5 text-[10px] font-bold">
                        #{idx + 1}
                      </span>
                      <span className="text-[11px] font-semibold text-neutral-200 truncate">
                        {match.filename}
                      </span>
                      <span className="text-[10px] text-neutral-500">
                        (Chunk ID: {match.chunk_id})
                      </span>
                    </div>

                    {/* Ranking Scores breakdown badge group */}
                    <div className="flex items-center gap-2 text-[10px]">
                      <div className="flex items-center gap-1 border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-neutral-200">
                        <span className="text-neutral-500">RRF Score:</span>
                        <span className="font-bold">{match.score.toFixed(4)}</span>
                      </div>

                      <div className="flex items-center gap-1 border border-neutral-800 bg-neutral-900 px-2 py-0.5">
                        <span className="text-neutral-500">Dense (TEI):</span>
                        <span className="text-emerald-400 font-bold">
                          {match.dense_score !== null ? match.dense_score.toFixed(4) : "N/A"}
                        </span>
                        <span className="text-neutral-500">
                          {match.dense_rank !== null ? `(Rank #${match.dense_rank})` : ""}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 border border-neutral-800 bg-neutral-900 px-2 py-0.5">
                        <span className="text-neutral-500">BM25 (GIN):</span>
                        <span className="text-sky-400 font-bold">
                          {match.bm25_score !== null ? match.bm25_score.toFixed(4) : "N/A"}
                        </span>
                        <span className="text-neutral-500">
                          {match.bm25_rank !== null ? `(Rank #${match.bm25_rank})` : ""}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Chunk content */}
                  <div className="text-[11px] text-neutral-300 leading-relaxed font-mono whitespace-pre-wrap bg-neutral-950 p-3 border border-neutral-900 select-text">
                    {match.content}
                  </div>
                </div>
              ))}
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-neutral-800 text-[10px] text-neutral-500 flex justify-between items-center bg-neutral-900/30">
              <span>Formula: RRF = 1 / (60 + DenseRank) + 1 / (60 + BM25Rank)</span>
              <span>pgvector (384-dim Cosine) & tsvector (English Dictionary)</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
