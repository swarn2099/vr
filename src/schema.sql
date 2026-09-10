CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS vr_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vr_products(id text PRIMARY KEY,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vr_sources(id text PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,kind text NOT NULL,identity text NOT NULL,enabled boolean NOT NULL DEFAULT true,principals jsonb NOT NULL DEFAULT '[]',checkpoint text,generation integer NOT NULL DEFAULT 0,remote_tip text,remote_checked_at timestamptz,attributes jsonb NOT NULL DEFAULT '{}',UNIQUE(product_id,kind,identity));
CREATE TABLE IF NOT EXISTS vr_snapshots(id text PRIMARY KEY,source_id text NOT NULL REFERENCES vr_sources,revision text NOT NULL,fingerprint text NOT NULL,overlay boolean NOT NULL DEFAULT false,coverage jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vr_files(snapshot_id text NOT NULL REFERENCES vr_snapshots,path text NOT NULL,content_hash text NOT NULL,status text NOT NULL,reason text,functions integer NOT NULL,units integer NOT NULL,PRIMARY KEY(snapshot_id,path));
CREATE TABLE IF NOT EXISTS vr_evidence(id text PRIMARY KEY,source_id text NOT NULL REFERENCES vr_sources,path text NOT NULL,revision text NOT NULL,content_hash text NOT NULL,kind text NOT NULL,label text NOT NULL,start_line integer NOT NULL,end_line integer NOT NULL,body text NOT NULL,metadata jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS vr_evidence_path ON vr_evidence(source_id,path,content_hash);
CREATE TABLE IF NOT EXISTS vr_snapshot_evidence(snapshot_id text NOT NULL REFERENCES vr_snapshots,evidence_id text NOT NULL REFERENCES vr_evidence,PRIMARY KEY(snapshot_id,evidence_id));
CREATE TABLE IF NOT EXISTS vr_edges(snapshot_id text NOT NULL REFERENCES vr_snapshots,from_path text NOT NULL,to_path text NOT NULL,kind text NOT NULL,basis text NOT NULL,resolved boolean NOT NULL,PRIMARY KEY(snapshot_id,from_path,to_path,kind));
CREATE INDEX IF NOT EXISTS vr_edges_reverse ON vr_edges(snapshot_id,to_path);
CREATE TABLE IF NOT EXISTS vr_behaviors(id text PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,alias text NOT NULL,title text NOT NULL,revision integer NOT NULL DEFAULT 0,UNIQUE(product_id,alias));
CREATE TABLE IF NOT EXISTS vr_assertions(behavior_id text NOT NULL REFERENCES vr_behaviors,revision integer NOT NULL,schema_version integer NOT NULL DEFAULT 1,statement text NOT NULL,conditions jsonb NOT NULL,exceptions jsonb NOT NULL,basis text NOT NULL,temporal text NOT NULL,checks jsonb NOT NULL,paths jsonb NOT NULL,extensions jsonb NOT NULL,model text,review text NOT NULL DEFAULT 'unreviewed',authority jsonb,scope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(behavior_id,revision));
CREATE TABLE IF NOT EXISTS vr_support(behavior_id text NOT NULL,revision integer NOT NULL,evidence_id text NOT NULL REFERENCES vr_evidence,role text NOT NULL CHECK(role IN ('supports','contradicts','context')),PRIMARY KEY(behavior_id,revision,evidence_id,role),FOREIGN KEY(behavior_id,revision) REFERENCES vr_assertions);
CREATE INDEX IF NOT EXISTS vr_support_reverse ON vr_support(evidence_id);
CREATE TABLE IF NOT EXISTS vr_relations(id text PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,from_id text NOT NULL REFERENCES vr_behaviors,to_id text NOT NULL REFERENCES vr_behaviors,kind text NOT NULL,basis text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS vr_relations_out ON vr_relations(product_id,from_id);
CREATE INDEX IF NOT EXISTS vr_relations_in ON vr_relations(product_id,to_id);
CREATE TABLE IF NOT EXISTS vr_search(behavior_id text PRIMARY KEY REFERENCES vr_behaviors,revision integer NOT NULL,body text NOT NULL,lexemes tsvector GENERATED ALWAYS AS(to_tsvector('english',body)) STORED,embedding vector(384),embedding_model text);
CREATE INDEX IF NOT EXISTS vr_search_lexical ON vr_search USING gin(lexemes);
CREATE TABLE IF NOT EXISTS vr_jobs(id text PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,source_id text NOT NULL REFERENCES vr_sources,snapshot_id text NOT NULL REFERENCES vr_snapshots,stage text NOT NULL,state text NOT NULL DEFAULT 'pending',model text,calls integer NOT NULL DEFAULT 0,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vr_work(job_id text NOT NULL REFERENCES vr_jobs,unit_id text NOT NULL,evidence_ids jsonb NOT NULL,state text NOT NULL DEFAULT 'pending',error text,PRIMARY KEY(job_id,unit_id));
CREATE TABLE IF NOT EXISTS vr_batches(id text PRIMARY KEY,job_id text NOT NULL REFERENCES vr_jobs,unit_ids jsonb NOT NULL,evidence_ids jsonb NOT NULL,state text NOT NULL DEFAULT 'reserved',input_tokens integer,output_chars integer,model text,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);
CREATE TABLE IF NOT EXISTS vr_analysis_cache(source_id text NOT NULL REFERENCES vr_sources,stage text NOT NULL,input_hash text NOT NULL,parser_version text NOT NULL,model text NOT NULL,completed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_id,stage,input_hash,parser_version));
CREATE TABLE IF NOT EXISTS vr_questions(id text PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,question text NOT NULL,reason text NOT NULL,paths jsonb NOT NULL,evidence jsonb NOT NULL,state text NOT NULL DEFAULT 'open',revision integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vr_reviews(id text PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,target_id text NOT NULL,revision integer NOT NULL,predecessor text,actor jsonb NOT NULL,action text NOT NULL,old_value jsonb NOT NULL,new_value jsonb NOT NULL,reason text NOT NULL,scope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(target_id,revision));
CREATE TABLE IF NOT EXISTS vr_outbox(sequence bigserial PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,kind text NOT NULL,entity_id text NOT NULL,version integer NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vr_projection_cursors(name text PRIMARY KEY,sequence bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS vr_receipts(id text PRIMARY KEY,product_id text NOT NULL REFERENCES vr_products,kind text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vr_local_analysis(evidence_id text NOT NULL REFERENCES vr_evidence,model text NOT NULL,summary text NOT NULL,symbols jsonb NOT NULL,batch_id text NOT NULL REFERENCES vr_batches,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(evidence_id,model));
ALTER TABLE vr_batches ADD COLUMN IF NOT EXISTS raw_response text;
ALTER TABLE vr_questions ADD COLUMN IF NOT EXISTS source_ids jsonb NOT NULL DEFAULT '[]';
INSERT INTO vr_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;

-- Backfill provenance for questions written before source-scoped review access.
UPDATE vr_questions q SET source_ids=COALESCE((SELECT jsonb_agg(DISTINCT e.source_id) FROM vr_evidence e WHERE q.evidence ? e.id),'[]'::jsonb) WHERE q.source_ids='[]'::jsonb;

CREATE INDEX IF NOT EXISTS vr_assertions_paths ON vr_assertions USING gin(paths);
CREATE INDEX IF NOT EXISTS vr_jobs_active ON vr_jobs(product_id,snapshot_id,stage,state);
CREATE INDEX IF NOT EXISTS vr_work_pending ON vr_work(job_id,state);
CREATE INDEX IF NOT EXISTS vr_questions_product ON vr_questions(product_id,state);
INSERT INTO vr_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;

ALTER TABLE vr_batches ADD COLUMN IF NOT EXISTS request jsonb;
INSERT INTO vr_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
