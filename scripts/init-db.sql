-- Runs once, on first initialisation of an empty Postgres volume.
--
-- Creates the test database alongside the development one and installs the
-- extensions the schema depends on. pg_trgm backs the fuzzy title search in
-- the feed/search module (spec §7) and needs superuser rights, which is why it
-- lives here rather than in a Drizzle migration.

CREATE DATABASE greetings_test;

\connect greetings
CREATE EXTENSION IF NOT EXISTS pg_trgm;

\connect greetings_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;
