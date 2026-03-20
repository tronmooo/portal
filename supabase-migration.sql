-- ============================================================
-- LifeOS PostgreSQL Migration — Supabase
-- Creates all tables with user_id for multi-user RLS
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('person','pet','vehicle','account','property','subscription','medical','self','loan','investment','asset')),
  name TEXT NOT NULL,
  avatar TEXT,
  fields JSONB DEFAULT '{}'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  notes TEXT DEFAULT '',
  documents JSONB DEFAULT '[]'::jsonb,
  linked_trackers JSONB DEFAULT '[]'::jsonb,
  linked_expenses JSONB DEFAULT '[]'::jsonb,
  linked_tasks JSONB DEFAULT '[]'::jsonb,
  linked_events JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TRACKERS
-- ============================================================
CREATE TABLE IF NOT EXISTS trackers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'custom',
  unit TEXT,
  icon TEXT,
  fields JSONB DEFAULT '[]'::jsonb,
  linked_profiles JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracker_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tracker_id UUID NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  values JSONB DEFAULT '{}'::jsonb,
  computed JSONB DEFAULT '{}'::jsonb,
  notes TEXT,
  mood TEXT CHECK (mood IS NULL OR mood IN ('great','good','okay','bad','terrible')),
  tags JSONB DEFAULT '[]'::jsonb,
  timestamp TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TASKS
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  due_date TEXT,
  linked_profiles JSONB DEFAULT '[]'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- EXPENSES
-- ============================================================
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  category TEXT DEFAULT 'general',
  description TEXT NOT NULL,
  vendor TEXT,
  is_recurring BOOLEAN DEFAULT false,
  linked_profiles JSONB DEFAULT '[]'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  date TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- CALENDAR EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  end_time TEXT,
  end_date TEXT,
  all_day BOOLEAN DEFAULT false,
  description TEXT,
  location TEXT,
  category TEXT DEFAULT 'personal' CHECK (category IN ('personal','work','health','finance','family','social','travel','education','other')),
  color TEXT,
  recurrence TEXT DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','biweekly','monthly','yearly')),
  recurrence_end TEXT,
  linked_profiles JSONB DEFAULT '[]'::jsonb,
  linked_documents JSONB DEFAULT '[]'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual','chat','ai','external')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- HABITS
-- ============================================================
CREATE TABLE IF NOT EXISTS habits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  frequency TEXT DEFAULT 'daily' CHECK (frequency IN ('daily','weekly','custom')),
  target_days JSONB DEFAULT '[]'::jsonb,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS habit_checkins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  habit_id UUID NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value NUMERIC,
  notes TEXT,
  timestamp TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- OBLIGATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS obligations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  frequency TEXT DEFAULT 'monthly' CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','yearly','once')),
  category TEXT DEFAULT 'general',
  next_due_date TEXT NOT NULL,
  autopay BOOLEAN DEFAULT false,
  linked_profiles JSONB DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS obligation_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  obligation_id UUID NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  date TEXT NOT NULL,
  method TEXT,
  confirmation_number TEXT
);

-- ============================================================
-- ARTIFACTS (notes & checklists)
-- ============================================================
CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('checklist','note')),
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  items JSONB DEFAULT '[]'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  linked_profiles JSONB DEFAULT '[]'::jsonb,
  pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- JOURNAL ENTRIES
-- ============================================================
CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  mood TEXT NOT NULL CHECK (mood IN ('amazing','good','neutral','bad','awful')),
  content TEXT DEFAULT '',
  tags JSONB DEFAULT '[]'::jsonb,
  energy INTEGER CHECK (energy IS NULL OR (energy >= 1 AND energy <= 5)),
  gratitude JSONB DEFAULT '[]'::jsonb,
  highlights JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- MEMORY (AI memory system)
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- DOCUMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'other',
  mime_type TEXT DEFAULT 'image/jpeg',
  file_data TEXT, -- base64 (will move to Supabase Storage later)
  extracted_data JSONB DEFAULT '{}'::jsonb,
  linked_profiles JSONB DEFAULT '[]'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- GOALS
-- ============================================================
CREATE TABLE IF NOT EXISTS goals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('weight_loss','weight_gain','savings','habit_streak','spending_limit','fitness_distance','fitness_frequency','tracker_target','custom')),
  target NUMERIC NOT NULL,
  current NUMERIC DEFAULT 0,
  unit TEXT NOT NULL,
  start_value NUMERIC,
  deadline TEXT,
  tracker_id TEXT,
  habit_id TEXT,
  category TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  milestones JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- DOMAINS (custom entity types)
-- ============================================================
CREATE TABLE IF NOT EXISTS domains (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  description TEXT,
  fields JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  "values" JSONB DEFAULT '{}'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- ENTITY LINKS (cross-entity relationships)
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  confidence NUMERIC DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- PREFERENCES (key-value settings per user)
-- ============================================================
CREATE TABLE IF NOT EXISTS preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  UNIQUE(user_id, key)
);

-- ============================================================
-- INDEXES for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_trackers_user ON trackers(user_id);
CREATE INDEX IF NOT EXISTS idx_tracker_entries_tracker ON tracker_entries(tracker_id);
CREATE INDEX IF NOT EXISTS idx_tracker_entries_user ON tracker_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(user_id, date);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
CREATE INDEX IF NOT EXISTS idx_habit_checkins_habit ON habit_checkins(habit_id);
CREATE INDEX IF NOT EXISTS idx_obligations_user ON obligations(user_id);
CREATE INDEX IF NOT EXISTS idx_obligation_payments_obligation ON obligation_payments(obligation_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_user ON journal_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_domains_user ON domains(user_id);
CREATE INDEX IF NOT EXISTS idx_domain_entries_domain ON domain_entries(domain_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_source ON entity_links(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_target ON entity_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_user ON entity_links(user_id);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — users can only access their own data
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trackers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracker_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE habits ENABLE ROW LEVEL SECURITY;
ALTER TABLE habit_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligation_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE preferences ENABLE ROW LEVEL SECURITY;

-- RLS Policies — authenticated users see only their own data
DO $$ 
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'profiles','trackers','tracker_entries','tasks','expenses','events',
    'habits','habit_checkins','obligations','obligation_payments',
    'artifacts','journal_entries','memories','documents','goals',
    'domains','domain_entries','entity_links','preferences'
  ]) LOOP
    EXECUTE format('
      CREATE POLICY "Users can view own %1$s" ON %1$s
        FOR SELECT USING (auth.uid() = user_id);
      CREATE POLICY "Users can insert own %1$s" ON %1$s
        FOR INSERT WITH CHECK (auth.uid() = user_id);
      CREATE POLICY "Users can update own %1$s" ON %1$s
        FOR UPDATE USING (auth.uid() = user_id);
      CREATE POLICY "Users can delete own %1$s" ON %1$s
        FOR DELETE USING (auth.uid() = user_id);
    ', t);
  END LOOP;
END $$;

-- Full text search indexes (for search functionality)
CREATE INDEX IF NOT EXISTS idx_profiles_name_search ON profiles USING gin(to_tsvector('english', name || ' ' || COALESCE(notes, '')));
CREATE INDEX IF NOT EXISTS idx_tasks_title_search ON tasks USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '')));
CREATE INDEX IF NOT EXISTS idx_events_title_search ON events USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '')));
CREATE INDEX IF NOT EXISTS idx_artifacts_title_search ON artifacts USING gin(to_tsvector('english', title || ' ' || COALESCE(content, '')));
CREATE INDEX IF NOT EXISTS idx_journal_content_search ON journal_entries USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING gin(to_tsvector('english', key || ' ' || value));
