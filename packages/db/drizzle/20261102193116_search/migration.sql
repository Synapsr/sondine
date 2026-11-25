-- Full-text index over segments.text (external content, no copy of the text).
-- Maintained explicitly by publishAnalysis and deleteEpisode, not by triggers:
-- drizzle-kit rebuilds SQLite tables (create, copy, drop, rename) for most
-- ALTERs, and dropping the old table silently drops its triggers.
CREATE VIRTUAL TABLE `segments_fts` USING fts5(
	text,
	content='segments',
	content_rowid='id',
	tokenize='unicode61 remove_diacritics 2',
	prefix='2 3'
);
--> statement-breakpoint
-- Deleted tokens are removed from the index b-trees immediately instead of
-- waiting for a merge; required with PRAGMA secure_delete for real erasure.
INSERT INTO `segments_fts`(`segments_fts`, `rank`) VALUES ('secure-delete', 1);
