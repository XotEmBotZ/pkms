import os
import json
import logging
from contextlib import asynccontextmanager
from typing import List, Optional
import httpx
import asyncpg
from pgvector.asyncpg import register_vector
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from minio import Minio

# Configuration
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "172.18.0.2")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "15432"))
POSTGRES_DB = os.getenv("POSTGRES_DB", "pkms")
POSTGRES_USER = os.getenv("POSTGRES_USER", "pkms")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "pkms_password")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "172.18.0.2:19000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ROOT_USER", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_ROOT_PASSWORD", "minioadmin_password")
MINIO_BUCKET = "documents"

RABBITMQ_USER = os.getenv("RABBITMQ_USER", "guest")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "guest_password")
RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "172.18.0.2")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", "15672"))
BROKER_URL = f"amqp://{RABBITMQ_USER}:{RABBITMQ_PASSWORD}@{RABBITMQ_HOST}:{RABBITMQ_PORT}//"

from celery import Celery
celery_app = Celery("ingestion_tasks", broker=BROKER_URL)
celery_app.conf.task_default_queue = "ingestion_tasks"

TEI_ENDPOINT = os.getenv("TEI_ENDPOINT", "http://172.18.0.2:18080")
OLLAMA_ENDPOINT = os.getenv("OLLAMA_ENDPOINT", "http://pkms-ollama:11434")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pkms-backend")

db_pool: Optional[asyncpg.Pool] = None
minio_client: Optional[Minio] = None


async def get_embedding(text: str) -> List[float]:
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{TEI_ENDPOINT}/embed",
            json={"inputs": text},
            timeout=10.0,
        )
        if res.status_code != 200:
            raise HTTPException(status_code=500, detail="Failed to generate embedding")
        data = res.json()
        return data[0] if isinstance(data[0], list) else data


async def generate_llm_response(query: str, context: str) -> str:
    """Invoke Mistral model on Ollama using retrieved context."""
    system_prompt = (
        "You are an expert AI knowledge assistant. Answer the user's question directly and concisely "
        "using ONLY the following context passages. Cite the document names where relevant. "
        "If the context does not contain enough information to answer the question, state that clearly."
    )
    user_prompt = f"Context:\n{context}\n\nQuestion: {query}\n\nAnswer:"
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            res = await client.post(
                f"{OLLAMA_ENDPOINT}/api/generate",
                json={
                    "model": "mistral:latest",
                    "prompt": f"{system_prompt}\n\n{user_prompt}",
                    "stream": False,
                },
            )
            if res.status_code == 200:
                answer = res.json().get("response", "").strip()
                if answer:
                    return answer
    except Exception as e:
        logger.warning(f"Ollama generation failed: {e}")
    return ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool, minio_client
    logger.info("Initializing database pool and MinIO client...")
    
    # MinIO
    minio_client = Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False,
    )
    if not minio_client.bucket_exists(MINIO_BUCKET):
        minio_client.make_bucket(MINIO_BUCKET)

    # Postgres
    async def init_connection(conn):
        await register_vector(conn)

    db_pool = await asyncpg.create_pool(
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        database=POSTGRES_DB,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
        init=init_connection,
        min_size=1,
        max_size=10,
    )

    async with db_pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL,
                size_bytes BIGINT NOT NULL,
                processed_content TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS document_chunks (
                id SERIAL PRIMARY KEY,
                document_id INT REFERENCES documents(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
                embedding VECTOR(384)
            );
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON document_chunks USING GIN(tsv);
        """)

    yield

    if db_pool:
        await db_pool.close()


app = FastAPI(title="PKMS Dual-Surface Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    query: str
    limit: int = 5
    min_dense_score: Optional[float] = None
    min_bm25_score: Optional[float] = None


class DocumentItem(BaseModel):
    id: int
    filename: str = ""
    size_bytes: int


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "pkms-backend"}


@app.get("/api/documents")
async def list_documents():
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT d.id, d.filename, d.size_bytes, COUNT(dc.id) as chunk_count
            FROM documents d
            LEFT JOIN document_chunks dc ON dc.document_id = d.id
            GROUP BY d.id, d.filename, d.size_bytes
            ORDER BY d.id DESC
        """)
        return [
            {
                "id": str(r["id"]),
                "name": r["filename"],
                "size": f"{max(1, round(r['size_bytes'] / 1024))} KB",
                "status": "ready" if r["chunk_count"] > 0 else "indexing",
                "chunk_count": r["chunk_count"],
            }
            for r in rows
        ]


@app.get("/api/documents/{doc_id}")
async def get_document(doc_id: int):
    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, filename, size_bytes, processed_content FROM documents WHERE id = $1",
            doc_id,
        )
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        
        chunks = await conn.fetch(
            "SELECT id, content FROM document_chunks WHERE document_id = $1 ORDER BY id ASC",
            doc_id,
        )

        # Fetch raw pre-processed binary/text from MinIO
        try:
            resp = minio_client.get_object(MINIO_BUCKET, doc["filename"])
            raw_bytes = resp.read()
            resp.close()
            resp.release_conn()
            raw_text = raw_bytes.decode("utf-8", errors="replace")
        except Exception:
            raw_text = "[Binary object in MinIO]"

        return {
            "id": str(doc["id"]),
            "filename": doc["filename"],
            "size": f"{max(1, round(doc['size_bytes'] / 1024))} KB",
            "pre_processed": raw_text,
            "post_processed": doc["processed_content"] or "",
            "chunks": [c["content"] for c in chunks],
        }


class UpdateDocumentRequest(BaseModel):
    content: str


@app.put("/api/documents/{doc_id}")
async def update_document(doc_id: int, req: UpdateDocumentRequest):
    new_text = req.content.strip()
    if not new_text:
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow("SELECT id, filename FROM documents WHERE id = $1", doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        # Update processed content
        await conn.execute(
            "UPDATE documents SET processed_content = $1 WHERE id = $2",
            new_text,
            doc_id,
        )

        # Delete previous chunks and re-embed new content
        await conn.execute("DELETE FROM document_chunks WHERE document_id = $1", doc_id)

    # Chunk and embed
    import re
    raw_paras = [p.strip() for p in re.split(r"\n\s*\n", new_text) if p.strip()]
    chunks = raw_paras or [new_text]

    async with db_pool.acquire() as conn:
        for chunk in chunks[:25]:
            emb = await get_embedding(chunk[:512])
            await conn.execute(
                "INSERT INTO document_chunks (document_id, content, embedding) VALUES ($1, $2, $3)",
                doc_id,
                chunk,
                emb,
            )

    return {"status": "updated", "id": str(doc_id), "chunks": len(chunks)}


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: int):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("DELETE FROM documents WHERE id = $1 RETURNING filename", doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")
        try:
            minio_client.remove_object(MINIO_BUCKET, row["filename"])
        except Exception as e:
            logger.warning(f"Failed to remove MinIO object: {e}")
        return {"status": "deleted", "id": doc_id}


@app.post("/api/ingest")
async def ingest_document(file: UploadFile = File(...)):
    content_bytes = await file.read()
    filename = file.filename or "unknown.txt"
    size = len(content_bytes)

    # 1. Stream Blob to MinIO
    import io
    minio_client.put_object(
        MINIO_BUCKET,
        filename,
        io.BytesIO(content_bytes),
        length=size,
    )

    # 2. Insert document record
    async with db_pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "INSERT INTO documents (filename, size_bytes) VALUES ($1, $2) RETURNING id",
            filename,
            size,
        )

    # 3. Publish ingestion job to RabbitMQ queue
    celery_app.send_task(
        "ingest_document_task",
        args=[doc_id, filename],
        queue="ingestion_tasks",
    )

    return {
        "id": str(doc_id),
        "name": filename,
        "size": f"{max(1, round(size / 1024))} KB",
        "status": "ready",
    }


@app.post("/api/query")
async def query_knowledge(req: QueryRequest):
    if not req.query.trim() if hasattr(req.query, "trim") else not req.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    query_text = req.query.strip()
    emb = await get_embedding(query_text[:512])

    # Reciprocal Rank Fusion (RRF) between HNSW vector cosine and tsvector GIN
    sql = """
    WITH query_ts AS (
        SELECT COALESCE(
            (SELECT string_agg(lexeme, ' | ') FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS lexeme)::tsquery,
            plainto_tsquery('english', $2)
        ) AS tq
    ),
    vector_matches AS (
        SELECT dc.id, dc.content, d.filename,
               (1.0 - (dc.embedding <=> $1)) as dense_score,
               ROW_NUMBER() OVER (ORDER BY dc.embedding <=> $1) as rank
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        LIMIT 20
    ),
    text_matches AS (
        SELECT dc.id, dc.content, d.filename,
               ts_rank_cd(dc.tsv, q.tq) as bm25_score,
               ROW_NUMBER() OVER (ORDER BY ts_rank_cd(dc.tsv, q.tq) DESC) as rank
        FROM document_chunks dc
        CROSS JOIN query_ts q
        JOIN documents d ON d.id = dc.document_id
        WHERE q.tq IS NOT NULL AND dc.tsv @@ q.tq
        LIMIT 20
    )
    SELECT COALESCE(v.id, t.id) as chunk_id,
           COALESCE(v.content, t.content) as content,
           COALESCE(v.filename, t.filename) as filename,
           (COALESCE(1.0 / (60 + v.rank), 0.0) + COALESCE(1.0 / (60 + t.rank), 0.0)) as rrf_score,
           v.dense_score,
           v.rank as dense_rank,
           t.bm25_score,
           t.rank as bm25_rank
    FROM vector_matches v
    FULL OUTER JOIN text_matches t ON v.id = t.id
    ORDER BY rrf_score DESC
    LIMIT $3;
    """

    async with db_pool.acquire() as conn:
        rows = await conn.fetch(sql, emb, query_text, req.limit)

    results = []
    for r in rows:
        d_score = round(float(r["dense_score"]), 4) if r["dense_score"] is not None else None
        b_score = round(float(r["bm25_score"]), 4) if r["bm25_score"] is not None else None

        # Filter by minimum score thresholds if specified
        if req.min_dense_score is not None and (d_score is None or d_score < req.min_dense_score):
            continue
        if req.min_bm25_score is not None and (b_score is None or b_score < req.min_bm25_score):
            continue

        results.append({
            "chunk_id": r["chunk_id"],
            "content": r["content"],
            "filename": r["filename"],
            "score": round(float(r["rrf_score"]), 4),
            "dense_score": d_score,
            "dense_rank": int(r["dense_rank"]) if r["dense_rank"] is not None else None,
            "bm25_score": b_score,
            "bm25_rank": int(r["bm25_rank"]) if r["bm25_rank"] is not None else None,
        })

    # Generate assistant answer using Ollama Mistral LLM
    if results:
        sources = list(dict.fromkeys(r["filename"] for r in results))
        context_blocks = "\n\n".join(
            f"Document: {r['filename']}\nContent: {r['content']}" for r in results[:4]
        )
        llm_answer = await generate_llm_response(query_text, context_blocks)
        if not llm_answer:
            llm_answer = f"Found {len(results)} relevant passages from [{', '.join(sources)}]:\n\n" + "\n\n".join(
                f"• ({r['filename']}) {r['content'][:220]}..." for r in results[:2]
            )
        answer = llm_answer
    else:
        sources = []
        answer = f"No documents matched your query criteria and score thresholds."

    return {
        "answer": answer,
        "sources": sources,
        "matches": results,
    }
