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
    demoted_reason TEXT
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
