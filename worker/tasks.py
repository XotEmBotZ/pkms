import os
import io
import re
import tempfile
import logging
import httpx
import psycopg2
from pgvector.psycopg2 import register_vector
from minio import Minio
from celery import Celery
import fitz  # PyMuPDF
import docx

logger = logging.getLogger("pkms-worker")
logging.basicConfig(level=logging.INFO)

# Config
RABBITMQ_USER = os.getenv("RABBITMQ_USER", "guest")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "guest_password")
RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "172.18.0.2")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", "15672"))

BROKER_URL = f"amqp://{RABBITMQ_USER}:{RABBITMQ_PASSWORD}@{RABBITMQ_HOST}:{RABBITMQ_PORT}//"

POSTGRES_HOST = os.getenv("POSTGRES_HOST", "172.18.0.2")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "15432"))
POSTGRES_DB = os.getenv("POSTGRES_DB", "pkms")
POSTGRES_USER = os.getenv("POSTGRES_USER", "pkms")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "pkms_password")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "172.18.0.2:19000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ROOT_USER", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_ROOT_PASSWORD", "minioadmin_password")
MINIO_BUCKET = "documents"

TEI_ENDPOINT = os.getenv("TEI_ENDPOINT", "http://172.18.0.2:18080")

app = Celery("ingestion_tasks", broker=BROKER_URL)
app.conf.task_default_queue = "ingestion_tasks"


def get_minio():
    return Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False,
    )


def get_db():
    conn = psycopg2.connect(
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        dbname=POSTGRES_DB,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
    )
    register_vector(conn)
    return conn


TIKA_ENDPOINT = os.getenv("TIKA_ENDPOINT", "http://pkms-tika:9998")


def extract_text(file_bytes: bytes, filename: str) -> str:
    """Extract document text via Apache Tika Server."""
    try:
        res = httpx.put(
            f"{TIKA_ENDPOINT}/tika",
            content=file_bytes,
            headers={"Accept": "text/plain"},
            timeout=30.0,
        )
        if res.status_code == 200:
            extracted = res.text.strip()
            if extracted:
                logger.info(f"Successfully extracted text for {filename} using Apache Tika")
                return extracted
    except Exception as e:
        logger.error(f"Apache Tika extraction failed for {filename}: {e}")

    return file_bytes.decode("utf-8", errors="ignore").strip()


def chunk_text(text: str, max_chunk_len: int = 500) -> list[str]:
    """Semantic paragraph-based chunker with length boundaries."""
    raw_paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks = []
    current = ""

    for p in raw_paras:
        if len(current) + len(p) <= max_chunk_len:
            current = f"{current}\n\n{p}" if current else p
        else:
            if current:
                chunks.append(current)
            if len(p) > max_chunk_len:
                # Sub-split long paragraph by sentences
                sentences = re.split(r"(?<=[.!?])\s+", p)
                sub_chunk = ""
                for s in sentences:
                    if len(sub_chunk) + len(s) <= max_chunk_len:
                        sub_chunk = f"{sub_chunk} {s}" if sub_chunk else s
                    else:
                        if sub_chunk:
                            chunks.append(sub_chunk)
                        sub_chunk = s
                if sub_chunk:
                    chunks.append(sub_chunk)
                current = ""
            else:
                current = p

    if current:
        chunks.append(current)
    return chunks or [text]


def compute_embeddings_batch(chunks: list[str]) -> list[list[float]]:
    """Compute dense embeddings batch via Hugging Face TEI."""
    with httpx.Client() as client:
        # Process in batches of 8 (TEI configured max_batch_requests)
        embeddings = []
        for i in range(0, len(chunks), 8):
            batch = [c[:512] for c in chunks[i:i + 8]]
            res = client.post(
                f"{TEI_ENDPOINT}/embed",
                json={"inputs": batch},
                timeout=30.0,
            )
            if res.status_code != 200:
                raise RuntimeError(f"TEI batch embedding error: {res.text}")
            embeddings.extend(res.json())
        return embeddings


@app.task(name="ingest_document_task")
def ingest_document_task(document_id: int, filename: str):
    logger.info(f"Starting ingestion task for document {document_id}: {filename}")
    minio_client = get_minio()

    # 1. Fetch blob from MinIO
    resp = minio_client.get_object(MINIO_BUCKET, filename)
    file_bytes = resp.read()
    resp.close()
    resp.release_conn()

    # 2. Extract text (Pass 1 fast digital text)
    text = extract_text(file_bytes, filename)
    if not text:
        text = filename

    # 3. Semantic Chunking
    chunks = chunk_text(text)
    logger.info(f"Extracted {len(chunks)} chunks for {filename}")

    # 4. Dense Vector Generation via TEI
    embeddings = compute_embeddings_batch(chunks)

    # 5. Atomic Write to PostgreSQL
    conn = get_db()
    try:
        with conn.cursor() as cur:
            # Update processed normalized text
            cur.execute("UPDATE documents SET processed_content = %s WHERE id = %s", (text, document_id))
            # Delete any previous chunks
            cur.execute("DELETE FROM document_chunks WHERE document_id = %s", (document_id,))
            for chunk, emb in zip(chunks, embeddings):
                cur.execute(
                    "INSERT INTO document_chunks (document_id, content, embedding) VALUES (%s, %s, %s)",
                    (document_id, chunk, emb),
                )
        conn.commit()
        logger.info(f"Successfully indexed document {document_id} with {len(chunks)} chunks.")
    finally:
        conn.close()

    return {"status": "success", "document_id": document_id, "chunks": len(chunks)}
