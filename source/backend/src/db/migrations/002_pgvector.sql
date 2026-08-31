-- Add pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Alter document_chunks to use vector type
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding vector(256);

-- If the existing embedding_json was used, we can drop it. But wait, if it's new, we just drop the old and use the new.
-- However, we can just drop it entirely if we don't care about the SQLite json array anymore.
-- For compatibility with the updated code, we need 'embedding' to exist.
-- Actually, SQLite compatibility is gone since we are moving to Postgres.
ALTER TABLE document_chunks DROP COLUMN IF EXISTS embedding_json;
