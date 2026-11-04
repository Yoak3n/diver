//! 建表 SQL。

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    aliases TEXT NOT NULL,
    state_summary TEXT NOT NULL,
    weight REAL NOT NULL,
    tier TEXT NOT NULL,
    activation_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_discussed_at INTEGER NOT NULL,
    n_times INTEGER NOT NULL,
    uncertain INTEGER NOT NULL,
    demoted_at INTEGER,
    demoted_reason TEXT,
    scope TEXT NOT NULL DEFAULT 'owner'
);

CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id TEXT NOT NULL,
    statement TEXT NOT NULL,
    ts INTEGER NOT NULL,
    episode_id TEXT
);

CREATE TABLE IF NOT EXISTS relation_card (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT,
    profile TEXT NOT NULL DEFAULT '',
    agent_model TEXT NOT NULL DEFAULT '',
    relationship TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promises (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    due_at INTEGER,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS self_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    topic_id TEXT,
    ts INTEGER NOT NULL
);

-- 好奇心清单：从群聊 / 笔记 / 实体 / 订阅里长出来的待探索条目。
-- dedupe_key 唯一：普通词=归一化 term，release/watch 用稳定外部 id，
-- 保证同一词只入队一次、同一 release 不会因重复轮询反复入队。
CREATE TABLE IF NOT EXISTS curiosity_items (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    priority REAL NOT NULL,
    status TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    done_at INTEGER,
    topic_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_curiosity_dedupe ON curiosity_items(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_curiosity_status ON curiosity_items(status, last_seen_at);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT,
    mention_count INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS entity_attrs (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    attr_key TEXT NOT NULL,
    attr_value TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_until INTEGER,
    source_topic_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_attrs_entity ON entity_attrs(entity_id, attr_key);

CREATE TABLE IF NOT EXISTS entity_relations (
    id TEXT PRIMARY KEY,
    from_entity_id TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    source_topic_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_rel_from ON entity_relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_rel_to ON entity_relations(to_entity_id);
"#;
